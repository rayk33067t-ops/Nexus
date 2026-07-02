const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Get all generated projects
app.get("/projects", (req, res) => {
  const dir = path.join(__dirname, "../output/projects");

  const projects = fs.readdirSync(dir).map(name => {
    const full = path.join(dir, name);
    return {
      name,
      files: fs.readdirSync(full)
    };
  });

  res.json(projects);
});

// Trigger generator (bridge to your engine)
app.post("/generate", (req, res) => {
  const input = req.body.input;

  // call your existing CLI system
  const { execSync } = require("child_process");

  const result = execSync(
    `npx ts-node --compiler-options '{"module":"CommonJS"}' ../src/genesis/run.ts "${input}"`
  ).toString();

  res.send(result);
});

app.listen(4000, () => {
  console.log("Genesis Dashboard running on http://localhost:4000");
});
