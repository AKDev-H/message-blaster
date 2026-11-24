import type { DatabaseSync } from 'node:sqlite';
import { AuthStore } from '../auth/store.js';
import type { BaseEnvironment } from '../config/env.js';
import { openDatabase } from '../database/connection.js';
import { WorkerBusyError } from '../errors.js';
import { recoverInterruptedCampaigns } from '../services/live-campaign.service.js';
import { migrateSettings, withSavedSettings } from '../services/settings.service.js';
import { WhatsAppLinker } from '../services/whatsapp/link.js';
import { Store } from '../store/index.js';
import { LiveUpdates } from './live-updates.js';
import type { App } from './routes/route.js';
import { WebRunner } from './runner.js';

export interface OpenedApp {
    app: App;
    databases: DatabaseSync[];
}

export async function openApp(env: BaseEnvironment): Promise<OpenedApp> {
    const db = await openMainDatabase(env);
    const observer = openOrClose(env.DATABASE_URL, db);
    return { app: createApp(env, db, observer), databases: [observer, db] };
}

export function closeDatabases(databases: readonly DatabaseSync[]): void {
    for (const db of databases) db.close();
}

async function openMainDatabase(env: BaseEnvironment): Promise<DatabaseSync> {
    const db = openDatabase(env.DATABASE_URL);
    try {
        migrateSettings(db, env);
        await recoverInterruptedCampaigns(new Store(db), env.DATABASE_URL);
    } catch (error) {
        if (error instanceof WorkerBusyError) return db;
        db.close();
        throw error;
    }
    return db;
}

function openOrClose(path: string, other: DatabaseSync): DatabaseSync {
    try {
        return openDatabase(path);
    } catch (error) {
        other.close();
        throw error;
    }
}

function createApp(env: BaseEnvironment, db: DatabaseSync, observer: DatabaseSync): App {
    const store = new Store(db);
    const readVersion = observer.prepare('PRAGMA data_version');
    const settings = () => withSavedSettings(env, db);
    const updates = new LiveUpdates(() => Number(readVersion.get()?.data_version), () => app.snapshot());
    const runner = new WebRunner(store, settings, () => updates.changed());
    const app: App = {
        env, db, store, runner, updates, settings, templates: new Map(),
        authStore: new AuthStore(db),
        whatsapp: new WhatsAppLinker(env, () => {}),
        snapshot: () => campaignSnapshot(app),
    };
    return app;
}

function campaignSnapshot({ env, store, runner, updates }: App) {
    const active = new Set(store.listActiveCampaignIds());
    if (runner.activeId) active.add(runner.activeId);
    return { dryRun: env.DRY_RUN, ai: Boolean(env.GROQ_API_KEY), revision: updates.revision, active: [...active] };
}
