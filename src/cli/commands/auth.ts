import { InvalidArgumentError, Option, type Command } from 'commander';
import { AuthStore, type AuthRole, type AuthUser } from '../../auth/store.js';
import { terminalText } from '../../utils/terminal.util.js';
import { withDatabase } from '../context.js';
import { integer } from '../options.js';

export function registerAuthCommands(program: Command): void {
    program.command('auth:bootstrap').description('Approve the first dashboard administrator')
        .argument('<email>', 'Google account email')
        .action((email: string) => withAuth(store => printUser(store.bootstrap(email))));

    program.command('auth:invite').description('Approve a Google account for dashboard access')
        .argument('<email>', 'Google account email')
        .addOption(new Option('--role <role>', 'Dashboard role').choices(['operator', 'admin']).default('operator'))
        .action((email: string, { role }: { role: AuthRole }) => withAuth(store => printUser(store.allowUser(email, role))));

    program.command('auth:list').description('List approved dashboard accounts and their status')
        .action(() => withAuth(store => console.table(store.listUsers().map(userView))));

    registerAccessCommand(program, false);
    registerAccessCommand(program, true);

    program.command('auth:revoke').description('Revoke an approved dashboard account’s active sessions')
        .argument('<email>', 'Google account email')
        .action((email: string) => withAuth(store => printRevoked(store.revokeUserSessions(requireUser(store, email).id))));

    program.command('auth:revoke-all').description('Revoke all active dashboard sessions')
        .action(() => withAuth(store => printRevoked(store.revokeAllSessions())));

    program.command('auth:audit-prune').description('Remove expired authentication records and older audit events')
        .option('--days <days>', 'Number of days of audit history to retain', retainedDays, 90)
        .action(({ days }: { days: number }) => withAuth(store => console.table([store.prune(Date.now(), days)])));
}

function registerAccessCommand(program: Command, enabled: boolean): void {
    program.command(enabled ? 'auth:enable' : 'auth:disable')
        .description(enabled ? 'Re-enable an approved dashboard account' : 'Disable a dashboard account and revoke its sessions')
        .argument('<email>', 'Google account email')
        .action((email: string) => withAuth(store => printUser(store.setUserEnabled(requireUser(store, email).id, enabled))));
}

function withAuth(action: (store: AuthStore) => void): Promise<void> {
    return withDatabase(db => action(new AuthStore(db)));
}

function retainedDays(value: string): number {
    const days = integer(value);
    if (days < 1) throw new InvalidArgumentError('Retain at least one day of audit history.');
    return days;
}

function requireUser(store: AuthStore, email: string): AuthUser {
    const user = store.userByEmail(email);
    if (!user) throw new Error('Dashboard account was not found.');
    return user;
}

function userView({ id, email, role, enabled }: AuthUser) {
    return { id, email: terminalText(email), role, status: enabled ? 'Enabled' : 'Disabled' };
}

function printUser(user: AuthUser): void {
    console.table([userView(user)]);
}

function printRevoked(count: number): void {
    console.log(`Revoked ${count} dashboard session(s).`);
}
