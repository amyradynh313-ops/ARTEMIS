const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const HF_TOKEN = process.env.HF_TOKEN;

// تست سرور
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "AI Image API is running 🚀"
  });
});

// تولید تصویر با Hugging Face
app.post("/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({
        error: "Prompt is required"
      });
    }

    if (!HF_TOKEN) {
      return res.status(500).json({
        error: "HF_TOKEN is not configured on the server"
      });
    }

    const response = await fetch(
      "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          inputs: prompt
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      return res.status(response.status).json({
        error: "Hugging Face API error",
        details: errorText
      });
    }

    const imageBuffer = Buffer.from(
      await response.arrayBuffer()
    );

    res.set("Content-Type", "image/png");
    res.send(imageBuffer);

  } catch (error) {
    console.error("Server error:", error);

    res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
});

// اجرای سرور
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
