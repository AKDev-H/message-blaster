import { runCli } from './cli/index.js';

process.umask(0o077);

try {
    await runCli(process.argv);
} catch (error) {
    console.error(error instanceof Error ? error.message : 'The command failed.');
    process.exitCode = 1;
}
