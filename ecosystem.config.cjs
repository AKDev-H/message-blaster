module.exports = {
    apps: [{
        name: 'message-blaster',
        cwd: __dirname,
        script: 'src/web/index.ts',
        interpreter: 'node',
        interpreter_args: '--import tsx',
        exec_mode: 'fork',
        instances: 1,
        autorestart: true,
        restart_delay: 5000,
        kill_timeout: 60000,
        max_memory_restart: '600M',
        out_file: './logs/pm2-out.log',
        error_file: './logs/pm2-error.log',
        time: true,
    }],
};
