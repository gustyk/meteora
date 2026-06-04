module.exports = {
  apps: [
    {
      name: "meridian",
      script: "index.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 10000,        // 10s between restarts
      max_restarts: 50,            // allow many restarts over days
      min_uptime: "30s",           // consider "stable" after 30s
      kill_timeout: 15000,         // 15s graceful shutdown
      watch: false,                // don't watch files (causes unwanted restarts)
      max_memory_restart: "500M",  // restart if memory > 500MB
      exp_backoff_restart_delay: 100, // exponential backoff: 100ms, 200ms, 400ms...
      env: {
        NODE_ENV: "production",
        DRY_RUN: "true",           // DRY_RUN for testing
      },
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
