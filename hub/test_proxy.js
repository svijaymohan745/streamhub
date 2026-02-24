const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

app.use(createProxyMiddleware({
    target: 'http://localhost:6987',
    changeOrigin: true,
    pathFilter: '/api/stream',
    pathRewrite: {
        '^/api/stream': '/stream',
    },
    on: {
        proxyReq: (proxyReq, req, res) => {
            console.log('Proxying to:', proxyReq.path);
        }
    }
}));

app.listen(3002, () => console.log('Test server running on 3002'));
