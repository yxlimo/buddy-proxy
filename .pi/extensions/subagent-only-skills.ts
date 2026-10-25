// Keeps subagent-only skills out of the main agent's system prompt.
//
// Pi loads every skill under <project>/.pi/skills at startup and advertises it
// in the system prompt (<available_skills>). This project keeps the JS reverse
// skill there so pi registers it (and `/skill:<name>` still works for a human),
// but the main agent must not see it: only pi-subagents children get it, through
// their agent definition (`skills:` + `skillPath:`).
//
// The skill list reaches the prompt through `before_agent_start`, so dropping the
// entry from `systemPromptOptions.skills` removes it from the rendered prompt.
// Children are unaffected: pi-subagents injects their skills into the child
// prompt text, and it gives the child no pi-level skill catalogue
// (`noSkills: !inheritSkills`).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Skill names that subagents may load but the main agent must not see.
const SUBAGENT_ONLY_SKILLS = new Set(["hello_js_reverse_skill"]);

export default function activate(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    if (!options?.skills?.length) return;
    const kept = options.skills.filter((skill) => !SUBAGENT_ONLY_SKILLS.has(skill.name));
    if (kept.length !== options.skills.length) {
      options.skills = kept;
    }
  });
}
