const express = require("express");
const path = require("path");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.post("/api/token", async (req, res) => {
  try {
    const { room, username, identity } = req.body;

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return res.status(500).json({
        error: "LiveKit environment variables not set.",
      });
    }

    if (!room || !username) {
      return res.status(400).json({
        error: "room and username are required.",
      });
    }

    /*
      중요:
      LiveKit identity는 참가자마다 unique해야 함.
      app.js에서 identity를 보내면 그걸 쓰고,
      안 보내면 서버에서 random identity를 만들어줌.
    */
    const safeUsername = String(username).trim() || "Participant";

    const participantIdentity =
      identity && String(identity).trim()
        ? String(identity).trim()
        : `${safeUsername.replace(/\s+/g, "-")}-${Math.random()
            .toString(36)
            .slice(2, 10)}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      name: safeUsername,
      ttl: "4h",
    });

    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    res.json({
      token,
      url: livekitUrl,
      identity: participantIdentity,
      name: safeUsername,
      room,
    });
  } catch (error) {
    console.error("Token error:", error);

    res.status(500).json({
      error: "Failed to create LiveKit token.",
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`InBetween server running on port ${PORT}`);
});