// Center_HUB (หน้าเว็บกลาง) — fork 1 ตัว (session เก็บในหน่วยความจำ ห้าม cluster)
// cd hub && pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'center-hub',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 4000,
      shutdown_with_message: true,
      windowsHide: true,
      time: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
