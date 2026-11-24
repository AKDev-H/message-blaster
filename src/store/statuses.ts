export const PENDING_STATUSES = "('PENDING','VALIDATING','QUEUED')";
export const UNFINISHED_STATUSES = "('PENDING','VALIDATING','QUEUED','SENDING')";
export const SENT_STATUSES = "('SENT','DELIVERED','READ')";
export const FAULT_STATUSES = "('FAILED','UNKNOWN')";

export const SENT_STATUS_NAMES: readonly string[] = ['SENT', 'DELIVERED', 'READ'];
export const WITHDRAWAL_ERROR = 'Consent withdrawn';
export const CANCELLED_ERROR = 'Campaign cancelled';

export const RECIPIENT_WITHDRAWN = `EXISTS (
    SELECT 1 FROM consent_withdrawals w WHERE w.recipient = m.recipient AND w.channel = c.channel
)`;
