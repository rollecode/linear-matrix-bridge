import { LINEAR_API_URL } from "./constants.js";
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

const FIND_ISSUE = `query FindIssue($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
    nodes { ${ISSUE_FIELDS} }
  }
}`;

export class LinearClient {
  private readonly url: string;
  private readonly token: string;
  private readonly actsAsApp: boolean;

  constructor(env: Env) {
    this.url = env.LINEAR_API_URL ?? LINEAR_API_URL;
    this.token = env.LINEAR_TOKEN;
    this.actsAsApp = env.LINEAR_AUTH_MODE === "oauth";
  }

  /** Personal API keys go in bare; OAuth access tokens take the Bearer scheme. */
  private authorization(): string {
    return this.actsAsApp ? `Bearer ${this.token}` : this.token;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: this.authorization(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new LinearError(`Linear API returned ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json<{ data?: T; errors?: { message: string }[] }>();
    if (payload.errors?.length) {
      throw new LinearError(payload.errors.map((error) => error.message).join("; "));
    }
    if (!payload.data) {
      throw new LinearError("Linear API returned no data");
    }

    return payload.data;
  }

  async createIssue(teamId: string, title: string, description?: string): Promise<LinearIssue> {
    const data = await this.graphql<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(CREATE_ISSUE, {
      input: { teamId, title, description },
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
  async createComment(issueId: string, body: string, authorName?: string): Promise<string> {
    const input: Record<string, unknown> = { issueId, body };
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
