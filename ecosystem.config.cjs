const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "maskword",
      cwd: __dirname,
      script: "apps/server/dist/index.js",
      interpreter: process.env.MASKWORD_NODE_INTERPRETER || "/www/server/nodejs/v24.12.0/bin/node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "2000",
        WEB_DIST_PATH: path.join(__dirname, "apps/web/dist"),
      },
    },
  ],
};
