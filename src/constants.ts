export const HTTP_OK = 200;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_METHOD_NOT_ALLOWED = 405;

export const MATRIX_ERRCODE_FORBIDDEN = "M_FORBIDDEN";
export const MATRIX_ERRCODE_NOT_FOUND = "M_NOT_FOUND";
export const MATRIX_ERRCODE_UNRECOGNIZED = "M_UNRECOGNIZED";

export const THREAD_REL_TYPE = "m.thread";
export const REPLACE_REL_TYPE = "m.replace";
export const HTML_FORMAT = "org.matrix.custom.html";
export const MESSAGE_EVENT_TYPE = "m.room.message";

export const DEDUPE_RETENTION_DAYS = 30;
export const MS_PER_DAY = 86_400_000;

/** Cap on events handled per appservice transaction, so one busy room cannot exhaust the Worker's subrequest budget. */
export const MAX_EVENTS_PER_TRANSACTION = 40;

/** Linear recommends rejecting webhooks whose timestamp is further than this from local time. */
export const WEBHOOK_MAX_CLOCK_SKEW_MS = 60_000;

export const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Longest title we will lift out of a replied-to message when `!linear` is used without one. */
export const DERIVED_TITLE_MAX_LENGTH = 120;
