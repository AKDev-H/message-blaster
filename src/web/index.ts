import { loadEnv } from '../config/env.js';
import { startWebServer } from './server.js';

process.umask(0o077);

try {
    const dashboard = await startWebServer(loadEnv());
    console.log(`Message Blaster dashboard · ${dashboard.url}`);
    const close = () => {
        void dashboard.close().catch(error => {
            console.error('Could not stop the dashboard', error);
            process.exitCode = 1;
        });
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
} catch (error) {
    console.error(error instanceof Error ? error.message : 'The web dashboard could not start.');
    process.exitCode = 1;
}
