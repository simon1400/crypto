module.exports = {
  apps: [{
    name: 'crypto-backend',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'production', PORT: 3001 }
  }]
}
