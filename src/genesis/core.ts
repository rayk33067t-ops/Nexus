import fs from "fs";
import path from "path";

export class GenesisCore {
  execute(input: string) {
    const projectName =
      input.toLowerCase().replace(/[^a-z0-9]+/g, "-") +
      "-" +
      Date.now();

    const projectPath = path.join("output/projects", projectName);

    const files = [
      {
        path: "src/server.ts",
        content: `
import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "auth system running" });
});

app.listen(3000, () => {
  console.log("Auth server running on port 3000");
});
`
      },

      {
        path: "src/auth/login.ts",
        content: `
export function login(username: string, password: string) {
  if (username === "admin" && password === "admin") {
    return { success: true, token: "demo-token" };
  }

  return { success: false, message: "Invalid credentials" };
}
`
      },

      {
        path: "src/auth/register.ts",
        content: `
export function register(username: string, password: string) {
  return {
    success: true,
    user: { username },
    message: "User registered (demo mode)"
  };
}
`
      },

      {
        path: "README.md",
        content: `
# Genesis Auth System (Clean Build)

Simple login system scaffold.

## Routes
- POST /login
- POST /register

## Note
This is a clean base system for expansion.
`
      }
    ];

    fs.mkdirSync(projectPath, { recursive: true });

    for (const file of files) {
      const fullPath = path.join(projectPath, file.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content);
    }

    return {
      input,
      status: "done",
      result: {
        project: projectName,
        path: projectPath,
        filesCreated: files.length
      }
    };
  }
}
