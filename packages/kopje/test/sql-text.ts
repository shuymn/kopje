// A statement's text with its whitespace collapsed, as the plan witnesses and the witness recording compare statements.
// Imports nothing, so that both the Workers suites and the Node suite (test-node/) read it.
export const normalized = (sql: string) => sql.replace(/\s+/g, " ").trim();
