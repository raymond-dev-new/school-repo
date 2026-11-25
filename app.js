// ============================================
// server.js - Backend (Node.js + Express)
// ============================================
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import bordyparser from 'body-parser'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(bordyparser.json());
app.use(express.static("public"));

// Connect to MongoDB - where post titles and text are saved
mongoose.connect(process.env.MONGO_URI);

// Connect to Cloudflare R2 - where pictures are saved
// Vercel does NOT serve pictures, Cloudflare does, so Vercel stays under 10GB
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

// Post model
const Post = mongoose.model("Post", new mongoose.Schema({
  type: { type: String, enum: ["news", "schoolNews"], required: true },
  title: String,
  content: String,
  imageUrl: String,
  externalLink: String,
  imageKey: String,
  createdAt: { type: Date, default: Date.now }
}));

// Multer - max 800KB so pictures stay small
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 800 * 1024 } });

// UPLOAD - Picture goes to Cloudflare R2
app.post("/api/upload", upload.single("image"), async (req, res) => {
  if (!req.file) return res.json({ url: "", key: "" });
  const fileName = Date.now() + "-" + req.file.originalname.replace(/\s/g, "");
  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: fileName,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
  }));
  res.json({ url: `${process.env.R2_PUBLIC_URL}/${fileName}`, key: fileName });
});

// VERIFY MANAGER PASSWORD - Check before opening dashboard
app.post("/api/verify", async (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Wrong password" });
});

// CREATE POST
app.post("/api/posts", async (req, res) => {
  if (req.headers["x-admin-pass"] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password" });
  res.json(await Post.create(req.body));
});

// GET POSTS - 10 at a time + Search by Title
app.get("/api/posts", async (req, res) => {
  const { type, search = "", page = 1 } = req.query;
  const filter = { type };
  if (search) filter.title = { $regex: search, $options: "i" };
  const posts = await Post.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 10).limit(10).lean();
  const total = await Post.countDocuments(filter);
  res.set("Cache-Control", "public, max-age=3600");
  res.json({ posts, hasMore: page * 10 < total });
});

// DELETE - Deletes from MongoDB AND from Cloudflare R2
app.delete("/api/posts/:id", async (req, res) => {
  if (req.headers["x-admin-pass"] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong password" });
  const post = await Post.findById(req.params.id);
  if (!post) return res.status(404).json({ error: "Not found" });
  // 1. Delete image from Cloudflare
  if (post.imageKey) {
    try { await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: post.imageKey })); } catch (e) { console.log("R2 delete error", e.message); }
  } else if (post.imageUrl) {
    const key = post.imageUrl.split("/").pop();
    try { await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })); } catch (e) {}
  }
  // 2. Delete post from MongoDB
  await Post.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// DELETE - Only Admin can delete ONE particular post
app.delete("/api/posts/:id", async (req, res) => {
  // THIS line must be INSIDE here, not at top of file
  if (req.headers["x-admin-pass"] !== process.env.ADMIN_PASS) {
    return res.status(401).send("Not Admin");
  }

  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).send("Not found");

    // Delete picture from Cloudflare if it has one
    if (post.imageKey) {
      // your Cloudflare delete code here
    }

    await Post.findByIdAndDelete(req.params.id);
    res.send({ ok: true });
  } catch (e) {
    res.status(500).send("Delete failed");
  }
});

app.listen(process.env.PORT || 3000, () => console.log(`Server is running on port ${process.env.PORT}`));