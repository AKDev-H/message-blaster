import type { DatabaseSync } from 'node:sqlite';
import { loadEnv, type Environment } from '../config/env.js';
import { openDatabase } from '../database/connection.js';
import { migrateSettings, withSavedSettings } from '../services/settings.service.js';
import { Store } from '../store/index.js';

type Action = (store: Store, env: Environment, db: DatabaseSync) => void | Promise<void>;

export async function withDb(action: Action): Promise<void> {
    const base = loadEnv();
    using db = openDatabase(base.DATABASE_URL);
    migrateSettings(db, base);
    await action(new Store(db), withSavedSettings(base, db), db);
}
