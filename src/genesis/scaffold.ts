import fs from "fs";
import path from "path";

export class ScaffoldEngine {
  basePath = "output/projects";

  createProject(projectName: string, structure: any) {
    const projectPath = path.join(this.basePath, projectName);

    // 1. create root folder
    fs.mkdirSync(projectPath, { recursive: true });

    // 2. safety check
    if (!structure?.files || !Array.isArray(structure.files)) {
      throw new Error("Invalid structure: missing files array");
    }

    // 3. build file tree
    for (const file of structure.files) {
      if (!file.path || !file.content) continue;

      const fullPath = path.join(projectPath, file.path);

      // ensure folder exists
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });

      // write file
      fs.writeFileSync(fullPath, file.content, "utf-8");
    }

    // 4. return summary
    return {
      project: projectName,
      path: projectPath,
      filesCreated: structure.files.length
    };
  }
}
