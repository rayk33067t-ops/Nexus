
import express from "express";
import { login } from "./auth/login";
import { register } from "./auth/register";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "auth server running" });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  res.json(login(username, password));
});

app.post("/register", (req, res) => {
  const { username, password } = req.body;
  res.json(register(username, password));
});

app.listen(3000, () => {
  console.log("Auth server running on port 3000");
});
