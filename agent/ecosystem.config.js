// Center_HUB Agent — fork 1 ตัวต่อเครื่องเท่านั้น (คุม PM2 / git / deploy ห้ามมีสองตัวทำงานซ้อน)
// รันด้วย Windows user เดียวกับที่รัน PM2 ของ project อื่น:  cd agent && pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'center-agent',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      wait_ready: true,
      listen_timeout: 15000,
      kill_timeout: 6000,
      shutdown_with_message: true,
      windowsHide: true,
      time: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
