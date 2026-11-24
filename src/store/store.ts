import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../database/transaction.js';
import type { CampaignChannel, MessageStatus, ReceiptStage } from '../types/index.js';
import * as campaigns from './campaigns.js';
import * as consent from './consent.js';
import * as delivery from './delivery.js';
import * as drafts from './drafts.js';
import * as lifecycle from './lifecycle.js';
import * as receipts from './receipts.js';
import * as recipients from './recipients.js';
import type { AttemptRecord, Campaign, CampaignSummary, ClaimedMessage, MessageRecord, Outcome, PreparedRow, WebDraft, WebDraftSettings } from './records.js';
import * as reviews from './reviews.js';
import * as tests from './test-confirmations.js';

export interface NewCampaign {
    id: string;
    rows: PreparedRow[];
    channel: CampaignChannel;
    isTest?: boolean;
    draft?: WebDraft | undefined;
}

export class Store {
    constructor(private readonly db: DatabaseSync) {}


    importCampaign(id: string, rows: PreparedRow[], isTest = false, channel: CampaignChannel = 'whatsapp', draft?: WebDraft): Campaign {
        return transaction(this.db, () => this.insertCampaign({ id, rows, channel, isTest, draft }));
    }

    importCampaigns(list: readonly NewCampaign[]): Campaign[] {
        return transaction(this.db, () => list.map(campaign => this.insertCampaign(campaign)));
    }


    getCampaign(id: string): Campaign {
        return campaigns.getCampaign(this.db, id);
    }

    campaignSummary(id: string): CampaignSummary {
        return campaigns.getCampaignSummary(this.db, id);
    }

    listCampaignSummaries(): CampaignSummary[] {
        return campaigns.listCampaignSummaries(this.db);
    }

    latestTestCampaign(channel: CampaignChannel): Campaign | undefined {
        return campaigns.latestTestCampaign(this.db, channel);
    }


    listMessages(id: string): MessageRecord[] {
        return recipients.listMessages(this.db, id);
    }

    listMessagePage(id: string, page: number, pageSize: number): recipients.MessagePage {
        return recipients.listMessagePage(this.db, id, page, pageSize);
    }

    progress(id: string): Record<MessageStatus, number> {
        return recipients.countByStatus(this.db, id);
    }


    getWebDraft(id: string): WebDraft | null {
        return drafts.getWebDraft(this.db, id);
    }

    getWebDraftSettings(id: string): WebDraftSettings | null {
        return drafts.getWebDraftSettings(this.db, id);
    }

    replaceWebDraft(id: string, rows: PreparedRow[], draft: WebDraft): Campaign {
        return drafts.replaceWebDraft(this.db, id, rows, draft);
    }


    start(id: string): Campaign {
        return lifecycle.activateCampaign(this.db, id, ['Ready']);
    }

    resume(id: string): Campaign {
        return lifecycle.activateCampaign(this.db, id, ['Paused', 'Failed']);
    }

    pause(id: string): Campaign {
        return lifecycle.pauseCampaign(this.db, id);
    }

    pauseIfRunning(id: string): Campaign {
        return lifecycle.leaveRunning(this.db, id, 'Paused');
    }

    setCampaignFailed(id: string): Campaign {
        return lifecycle.leaveRunning(this.db, id, 'Failed');
    }

    cancel(id: string): Campaign {
        return lifecycle.cancelCampaign(this.db, id);
    }

    retryFailed(id: string): number {
        return lifecycle.retryFailedMessages(this.db, id);
    }

    settleCampaign(id: string): Campaign {
        return lifecycle.settleCampaign(this.db, id);
    }

    deleteCampaign(id: string): void {
        lifecycle.deleteCampaign(this.db, id);
    }

    bindAccount(id: string, accountId: string): void {
        lifecycle.bindAccount(this.db, id, accountId);
    }


    peek(id: string, now = Date.now()): MessageRecord | undefined {
        return delivery.peekNextMessage(this.db, id, now);
    }

    nextAvailableAt(id: string): number | undefined {
        return delivery.nextAvailableAt(this.db, id);
    }

    claim(id: string, messageId: number, transportId: string): ClaimedMessage | undefined {
        return delivery.claimMessage(this.db, id, messageId, transportId);
    }

    canSubmit(messageId: number): boolean {
        return delivery.canSubmit(this.db, messageId);
    }

    finish(messageId: number, outcome: Outcome, error?: string, retryAt?: number, acknowledged = false): void {
        delivery.finishMessage(this.db, messageId, outcome, { error, retryAt, acknowledged });
    }

    receipt(whatsappId: string, stage: ReceiptStage): void {
        receipts.recordReceipt(this.db, whatsappId, stage);
    }

    recover(): number {
        return receipts.recoverInterrupted(this.db);
    }


    withdraw(recipient: string, channel: CampaignChannel = 'whatsapp'): number {
        return transaction(this.db, () => consent.withdrawConsent(this.db, recipient, channel));
    }

    isWithdrawn(recipient: string, channel: CampaignChannel = 'whatsapp'): boolean {
        return consent.isWithdrawn(this.db, recipient, channel);
    }


    isConfirmedTestCampaign(id: string): boolean {
        return tests.isConfirmedTestCampaign(this.db, id);
    }

    hasConfirmedTest(accountId: string): boolean {
        return tests.hasConfirmedTest(this.db, accountId);
    }

    confirmTest(id: string, accountId?: string): void {
        tests.confirmTest(this.db, id, accountId);
    }


    review(messageId: number, resolution: reviews.ReviewResolution, note: string, campaignId?: string): void {
        reviews.reviewMessage(this.db, messageId, resolution, note, campaignId);
    }

    attempts(messageId: number): AttemptRecord[] {
        return reviews.messageAttempts(this.db, messageId);
    }

    listAttempts(id: string): AttemptRecord[] {
        return reviews.campaignAttempts(this.db, id);
    }

    private insertCampaign({ id, rows, channel, isTest = false, draft }: NewCampaign): Campaign {
        campaigns.insertCampaign(this.db, id, isTest, channel);
        if (draft) drafts.saveWebDraft(this.db, id, draft);
        const hasEligible = recipients.insertRecipients(this.db, id, channel, isTest, rows);
        return hasEligible ? campaigns.setState(this.db, id, 'Ready') : this.getCampaign(id);
    }
}
