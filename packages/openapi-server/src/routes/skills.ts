// GET /skills, /skills/{id} — MCP's graffiticode://skills/<id> resources.
import type { Hono } from "hono";
import { getSkillCatalog } from "@graffiticode-app/core/skills";
import { notFound, unavailable } from "../problems.js";
import { publicBase } from "../spec.js";
import type { Validate } from "../app.js";

async function catalog() {
  try {
    return await getSkillCatalog();
  } catch (err) {
    console.error("[skills] catalog unavailable", (err as Error)?.message ?? err);
    throw unavailable("The skills catalog couldn't be read. Try again shortly.", 60);
  }
}

export function skillRoutes(app: Hono, validate: Validate) {
  app.get("/skills", async (c) => {
    const skills = await catalog();
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ data: skills.map(s => ({ id: s.id, name: s.name, description: s.description, url: `${publicBase()}/skills/${s.id}` })) });
  });

  app.get("/skills/:id", async (c) => {
    const { path } = validate(c, "get_skill");
    const skill = (await catalog()).find(s => s.id === path.id);
    if (!skill) throw notFound(`Skill ${path.id}`);
    c.header("Cache-Control", "public, max-age=60");
    return c.body(skill.text, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });
}
