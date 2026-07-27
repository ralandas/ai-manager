/**
 * pm2 process config. Runs the app with tsx (no build step needed) so the
 * source is the single source of truth on the server.
 * Start:   pm2 start ecosystem.config.cjs
 * Reload:  pm2 reload ai-manager
 * Logs:    pm2 logs ai-manager
 */
module.exports = {
  apps: [
    {
      name: 'ai-manager',
      cwd: '/opt/ai-manager',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: { NODE_ENV: 'production' },
      out_file: '/opt/ai-manager/logs/out.log',
      error_file: '/opt/ai-manager/logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
