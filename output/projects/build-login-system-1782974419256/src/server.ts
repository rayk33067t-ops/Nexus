
import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "auth system running" });
});

app.listen(3000, () => {
  console.log("Auth server running on port 3000");
});
