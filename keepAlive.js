const http = require("http");

function keepAlive() {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is alive!");
  });

  server.listen(process.env.PORT || 3000, () => {
    console.log("✅ Keep-alive server running...");
  });
}

module.exports = keepAlive;
