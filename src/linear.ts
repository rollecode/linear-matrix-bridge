import {
  HTTP_UNAUTHORIZED_STATUS,
  LINEAR_API_URL,
  LINEAR_APP_SCOPES,
  LINEAR_TOKEN_URL,
  TOKEN_REFRESH_MARGIN_MS,
} from "./constants.js";
import type { Env } from "./env.js";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export class LinearError extends Error {}

const ISSUE_FIELDS = "id identifier title url";

const CREATE_ISSUE = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;

const CREATE_COMMENT = `mutation CreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

const CREATE_ATTACHMENT = `mutation CreateAttachment($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id } }
}`;

const SEMANTIC_SEARCH = `query Suggest($query: String!, $maxResults: Int!) {
  semanticSearch(query: $query, maxResults: $maxResults, types: [issue]) {
    enabled
    results { issue { ${ISSUE_FIELDS} } }
  }
}`;

const FIND_ISSUE = `query FindIssue($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
    nodes { ${ISSUE_FIELDS} }
  }
}`;

// Shared across clients: a new LinearClient is built per event, the token outlives them.
let appToken: { value: string; expiresAt: number } | null = null;

export class LinearClient {
  private readonly url: string;
  private readonly token: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly actsAsApp: boolean;

  constructor(env: Env) {
    this.url = env.LINEAR_API_URL ?? LINEAR_API_URL;
    this.token = env.LINEAR_TOKEN ?? "";
    this.clientId = env.LINEAR_CLIENT_ID;
    this.clientSecret = env.LINEAR_CLIENT_SECRET;
    this.actsAsApp = this.usesClientCredentials() || env.LINEAR_AUTH_MODE === "oauth";
  }

  private usesClientCredentials(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private async appAccessToken(): Promise<string> {
    if (appToken && appToken.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return appToken.value;
    }

    const response = await fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: LINEAR_APP_SCOPES,
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
      }),
    });

    if (!response.ok) {
      throw new LinearError(`Linear token request returned ${response.status}: ${await response.text()}`);
    }

    const token = (await response.json()) as { access_token: string; expires_in: number };
    appToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };

    return appToken.value;
  }

  /** Personal API keys go in bare; OAuth access tokens take the Bearer scheme. */
  private async authorization(): Promise<string> {
    if (this.usesClientCredentials()) {
      return `Bearer ${await this.appAccessToken()}`;
    }

    return this.actsAsApp ? `Bearer ${this.token}` : this.token;
  }

  private async post(query: string, variables: Record<string, unknown>): Promise<Response> {
    return fetch(this.url, {
      method: "POST",
      headers: { Authorization: await this.authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response = await this.post(query, variables);

    // A revoked or rotated app token: drop it and ask for a new one, once.
    if (response.status === HTTP_UNAUTHORIZED_STATUS && this.usesClientCredentials()) {
      appToken = null;
      response = await this.post(query, variables);
    }

    if (!response.ok) {
      throw new LinearError(`Linear API returned ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (payload.errors?.length) {
      throw new LinearError(payload.errors.map((error) => error.message).join("; "));
    }
    if (!payload.data) {
      throw new LinearError("Linear API returned no data");
    }

    return payload.data;
  }

  async createIssue(teamId: string, title: string, description?: string, authorName?: string): Promise<LinearIssue> {
    const input: Record<string, unknown> = { teamId, title, description };
    if (this.actsAsApp && authorName) {
      input.createAsUser = authorName;
    }

    const data = await this.graphql<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(CREATE_ISSUE, {
      input,
    });

    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new LinearError("Linear refused to create the issue");
    }

    return data.issueCreate.issue;
  }

  /**
   * `createAsUser` attributes the comment to the Matrix sender, but Linear only
   * accepts it from an OAuth application running in actor=app mode.
   */
  async createComment(issueId: string, body: string, authorName?: string, parentId?: string | null): Promise<string> {
    const input: Record<string, unknown> = { issueId, body };
    if (parentId) {
      input.parentId = parentId;
    }
    if (this.actsAsApp && authorName) {
      input.createAsUser = authorName;
    }

    const data = await this.graphql<{ commentCreate: { success: boolean; comment: { id: string } | null } }>(
      CREATE_COMMENT,
      { input },
    );

    if (!data.commentCreate.success || !data.commentCreate.comment) {
      throw new LinearError("Linear refused to create the comment");
    }

    return data.commentCreate.comment.id;
  }

  /** Shows up under Resources on the issue, the way the Slack integration's links do. */
  async createAttachment(
    issueId: string,
    url: string,
    title: string,
    subtitle: string,
    iconUrl?: string,
  ): Promise<void> {
    await this.graphql<{ attachmentCreate: { success: boolean } }>(CREATE_ATTACHMENT, {
      input: { issueId, url, title, subtitle, iconUrl },
    });
  }

  /**
   * Linear's own semantic search. Keeping the ranking on their side means the
   * bridge runs no model and holds no prompt that could be talked into
   * answering something else.
   */
  async suggestIssues(query: string, maxResults: number): Promise<LinearIssue[]> {
    const data = await this.graphql<{
      semanticSearch: { enabled: boolean; results: { issue: LinearIssue | null }[] };
    }>(SEMANTIC_SEARCH, { query, maxResults });

    if (!data.semanticSearch.enabled) {
      return [];
    }

    return data.semanticSearch.results.map((result) => result.issue).filter((issue): issue is LinearIssue => !!issue);
  }

  async findIssueByIdentifier(identifier: string): Promise<LinearIssue | null> {
    const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
    if (!match) {
      return null;
    }

    const data = await this.graphql<{ issues: { nodes: LinearIssue[] } }>(FIND_ISSUE, {
      teamKey: match[1]!.toUpperCase(),
      number: Number(match[2]),
    });

    return data.issues.nodes[0] ?? null;
  }

  /** True when comments are attributed to the bridge itself rather than to a person. */
  get attributesToApp(): boolean {
    return this.actsAsApp;
  }
}
