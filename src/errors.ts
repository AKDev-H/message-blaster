export class NotFoundError extends Error {}

export class ConflictError extends Error {}

export class CampaignExistsError extends ConflictError {}

export class WorkerBusyError extends ConflictError {}
