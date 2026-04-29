const express = require('express');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

app.post('/api/token', async (req, res) => {
  const { room, username } = req.body;

  const apiKey    = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    return res.status(500).json({ error: 'LiveKit environment variables not set.' });
  }
  if (!room || !username) {
    return res.status(400).json({ error: 'room and username are required.' });
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity: username,
    name: username,
    ttl: '4h',
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();
  res.json({ token, url: livekitUrl });
});

app.listen(PORT, () => {
  console.log(`InBetween server running on http://localhost:${PORT}`);
});
