export const formatError = (cause: object): string => cause instanceof Error ? cause.message : JSON.stringify(cause)
