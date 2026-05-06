/**
 * Unit tests for `validateSkillFrontmatter`, the gate that prevents
 * `skill_save` from writing SKILL.md files that the SkillsManager would
 * silently reject at load time.
 */

import { describe, expect, it } from "vitest"

import { validateSkillFrontmatter } from "../SkillSaveTool"

const SLUG = "my-skill"

const wrap = (frontmatter: string, body = "# Body\n") => `---\n${frontmatter}\n---\n\n${body}`

describe("validateSkillFrontmatter", () => {
	it("accepts a minimal valid SKILL.md with matching name and description", () => {
		const content = wrap(`name: ${SLUG}\ndescription: A short summary.`)
		expect(validateSkillFrontmatter(content, SLUG)).toBeNull()
	})

	it("accepts extra optional fields", () => {
		const content = wrap(
			`name: ${SLUG}\ndescription: A short summary.\nmodeSlugs:\n  - code\napplyTo:\n  - example.com`,
		)
		expect(validateSkillFrontmatter(content, SLUG)).toBeNull()
	})

	it("rejects content without a leading `---` fence", () => {
		const content = `# No frontmatter\n\nBody.`
		expect(validateSkillFrontmatter(content, SLUG)).toMatch(/must start with a YAML frontmatter block/)
	})

	it("rejects content with a frontmatter block but no `name`", () => {
		const content = wrap(`description: A short summary.`)
		expect(validateSkillFrontmatter(content, SLUG)).toMatch(/missing the required `name` field/)
	})

	it("rejects content whose `name` does not match the slug", () => {
		const content = wrap(`name: other-slug\ndescription: A short summary.`)
		const err = validateSkillFrontmatter(content, SLUG)
		expect(err).toMatch(/does not match the skill slug/)
		expect(err).toContain(SLUG)
		expect(err).toContain("other-slug")
	})

	it("rejects content without `description`", () => {
		const content = wrap(`name: ${SLUG}`)
		expect(validateSkillFrontmatter(content, SLUG)).toMatch(/missing the required `description` field/)
	})

	it("rejects an empty/whitespace-only `description`", () => {
		const content = wrap(`name: ${SLUG}\ndescription: "   "`)
		expect(validateSkillFrontmatter(content, SLUG)).toMatch(/must be 1\u20131024 characters/)
	})

	it("rejects a `description` longer than 1024 characters", () => {
		const longDesc = "x".repeat(1025)
		const content = wrap(`name: ${SLUG}\ndescription: "${longDesc}"`)
		expect(validateSkillFrontmatter(content, SLUG)).toMatch(/must be 1\u20131024 characters/)
	})

	it("rejects malformed YAML in the frontmatter", () => {
		// Unclosed quote produces a YAML parse error.
		const content = `---\nname: ${SLUG}\ndescription: "unterminated\n---\n\nBody`
		expect(validateSkillFrontmatter(content, SLUG)).toMatch(/not valid YAML/)
	})

	it("accepts CRLF line endings", () => {
		const content = `---\r\nname: ${SLUG}\r\ndescription: ok\r\n---\r\n\r\nBody\r\n`
		expect(validateSkillFrontmatter(content, SLUG)).toBeNull()
	})
})
