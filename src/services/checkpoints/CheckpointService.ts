import fs from "fs/promises"
import { existsSync } from "fs"
import path from "path"

import simpleGit, { CommitResult, SimpleGit, VersionResult, CleanOptions } from "simple-git"

export interface Checkpoint {
	hash: string
	message: string
	timestamp?: Date
}

export type CheckpointServiceOptions = {
	taskId: string
	git?: SimpleGit
	baseDir: string
	log?: (message: string) => void
}

/**
 * The CheckpointService provides a mechanism for storing a snapshot of the
 * current VSCode workspace each time a Roo Code tool is executed. It uses Git
 * under the hood.
 *
 * It maintains two branches:
 * - A main branch for normal operation (the branch you are currently on).
 * - A hidden branch for storing checkpoints.
 *
 * How it works:
 * 1. When saving a checkpoint:
 *    - Current changes are stashed (including untracked files).
 *    - The hidden branch is reset to match main.
 *    - Stashed changes are applied and committed as a checkpoint on the hidden
 *      branch.
 *    - We return to the main branch with the original state restored.
 *
 * 2. When restoring a checkpoint:
 *    - The workspace is restored to the state of the specified checkpoint using
 *      `git restore` and `git clean`.
 *
 * This approach allows for:
 * - Non-destructive version control (main branch remains untouched).
 * - Preservation of the full history of checkpoints.
 * - Safe restoration to any previous checkpoint.
 *
 * Notes:
 * - Git must be installed.
 * - If the current working directory is not a Git repository, we will
 *   initialize a new one with a .gitkeep file.
 * - If you manually edit files and then restore a checkpoint, the changes
 *   will be lost. Addressing this adds some complexity to the implementation
 *   and it's not clear whether it's worth it.
 */

export class CheckpointService {
	constructor(
		public readonly taskId: string,
		private readonly git: SimpleGit,
		public readonly baseDir: string,
		public readonly mainBranch: string,
		public readonly baseCommitHash: string,
		public readonly hiddenBranch: string,
		private readonly log: (message: string) => void,
	) {}

	private async pushStash() {
		const status = await this.git.status()

		if (status.files.length > 0) {
			await this.git.stash(["-u"]) // Stash tracked and untracked files.
			return true
		} else {
			return false
		}
	}

	private async applyStash() {
		const stashList = await this.git.stashList()

		if (stashList.all.length > 0) {
			await this.git.stash(["apply"]) // Apply the most recent stash.
			return true
		} else {
			return false
		}
	}

	private async popStash() {
		const stashList = await this.git.stashList()

		if (stashList.all.length > 0) {
			await this.git.stash(["pop"]) // Pop the most recent stash.
			return true
		} else {
			return false
		}
	}

	private async ensureBranch(expectedBranch: string) {
		const branch = await this.git.revparse(["--abbrev-ref", "HEAD"]) // git rev-parse --abbrev-ref HEAD

		if (branch.trim() !== expectedBranch) {
			throw new Error(`Git branch mismatch: expected '${expectedBranch}' but found '${branch}'`)
		}
	}

	public async getDiff({ from, to }: { from?: string; to: string }) {
		const result = []

		if (!from) {
			from = this.baseCommitHash
		}

		const { files } = await this.git.diffSummary([`${from}..${to}`])

		for (const file of files.filter((f) => !f.binary)) {
			const relPath = file.file
			const absPath = path.join(this.baseDir, relPath)
			let beforeContent = ""
			let afterContent = ""

			// Try to get content from both commits - handles all cases:
			// - Modified: both will succeed
			// - Added: only 'to' will succeed
			// - Deleted: only 'from' will succeed
			try {
				beforeContent = await this.git.show([`${from}:${relPath}`])
			} catch (err) {
				// File didn't exist in older commit => remains empty.
			}

			try {
				afterContent = await this.git.show([`${to}:${relPath}`])
			} catch (err) {
				// File didn't exist in newer commit => remains empty.
			}

			result.push({
				paths: { relative: relPath, absolute: absPath },
				content: { before: beforeContent, after: afterContent },
			})
		}

		return result
	}

	public async saveCheckpoint(message: string) {
		await this.ensureBranch(this.mainBranch)

		// Attempt to stash pending changes (including untracked files).
		const pendingChanges = await this.pushStash() // git stash -u

		// Get the latest commit on the hidden branch before we reset it.
		const latestHash = await this.git.revparse([this.hiddenBranch]) // git rev-parse <hiddenBranch>

		// Check if there is any diff relative to the last checkpoint.
		if (!pendingChanges) {
			const diff = await this.git.diff([latestHash]) // git diff <latestHash>

			if (!diff) {
				this.log(`[saveCheckpoint] No changes relative to previous checkpoint; nothing to commit.`)
				return undefined
			}
		}

		await this.git.checkout(this.hiddenBranch) // git checkout <hiddenBranch>

		const reset = async () => {
			await this.git.reset(["HEAD", "."]) // git reset HEAD .
			await this.git.clean([CleanOptions.FORCE, CleanOptions.RECURSIVE]) // git clean -f -d
			await this.git.reset(["--hard", latestHash]) // git reset --hard <latestHash>
			await this.git.checkout(this.mainBranch) // git checkout <mainBranch>
			await this.popStash() // git stash pop
		}

		try {
			// Reset hidden branch to match main and apply the pending changes.
			await this.git.reset(["--hard", this.mainBranch]) // git reset --hard <mainBranch>

			// Only try to apply stash if we had pending changes.
			if (pendingChanges) {
				await this.applyStash() // git stash apply 0
			}

			// Using "-A" ensures that deletions are staged as well.
			await this.git.add(["-A"]) // git add -A
			const diff = await this.git.diff([latestHash]) // git diff <latestHash>

			if (!diff) {
				// If the diff is empty and there are no untracked files then we
				// don't need to commit.
				this.log(`[saveCheckpoint] Diff is empty, no untracked files`)
				await reset()
				return undefined
			}

			// Otherwise, commit the changes.
			const status = await this.git.status() // git status
			this.log(`[saveCheckpoint] Changes detected, committing ${JSON.stringify(status)}`)

			const commit = await this.git.commit(message, undefined, {
				"--allow-empty": null,
				"--no-verify": null, // Skip pre-commit hooks.
			})

			await this.git.checkout(this.mainBranch)

			// Only pop stash if we had stashed something earlier.
			if (pendingChanges) {
				await this.popStash() // git stash pop
			}

			return commit
		} catch (err) {
			this.log(`[saveCheckpoint] Failed to save checkpoint: ${err instanceof Error ? err.message : String(err)}`)

			// If we're not on the main branch, we need to trigger a reset
			// (equivalent to the empty diff case above).
			// This ensures that we return to the main branch and restore the
			// pending changes.
			const currentBranch = await this.git.revparse(["--abbrev-ref", "HEAD"])

			if (currentBranch.trim() !== this.mainBranch) {
				await reset()
			}

			throw err
		}
	}

	public async restoreCheckpoint(commitHash: string) {
		await this.ensureBranch(this.mainBranch)
		await this.git.clean([CleanOptions.FORCE, CleanOptions.RECURSIVE])
		await this.git.raw(["restore", "--source", commitHash, "--worktree", "--", "."])
	}

	public static async create({ taskId, git, baseDir, log = console.log }: CheckpointServiceOptions) {
		git =
			git ||
			simpleGit({
				baseDir,
				binary: "git",
				maxConcurrentProcesses: 1,
				config: [],
				trimmed: true,
			})

		const version = await git.version()

		if (!version?.installed) {
			throw new Error(`Git is not installed. Please install Git if you wish to use checkpoints.`)
		}

		if (!baseDir || !existsSync(baseDir)) {
			throw new Error(`Base directory is not set or does not exist.`)
		}

		const { currentBranch, currentSha, hiddenBranch } = await CheckpointService.initRepo({
			taskId,
			git,
			baseDir,
			log,
		})

		log(
			`[CheckpointService] taskId = ${taskId}, baseDir = ${baseDir}, currentBranch = ${currentBranch}, currentSha = ${currentSha}, hiddenBranch = ${hiddenBranch}`,
		)
		return new CheckpointService(taskId, git, baseDir, currentBranch, currentSha, hiddenBranch, log)
	}

	private static async initRepo({ taskId, git, baseDir, log }: Required<CheckpointServiceOptions>) {
		const isExistingRepo = existsSync(path.join(baseDir, ".git"))

		if (!isExistingRepo) {
			await git.init()
			log(`[initRepo] Initialized new Git repository at ${baseDir}`)
		}

		await git.addConfig("user.name", "Roo Code")
		await git.addConfig("user.email", "support@roo.vet")

		if (!isExistingRepo) {
			// We need at least one file to commit, otherwise the initial
			// commit will fail, unless we use the `--allow-empty` flag.
			// However, using an empty commit causes problems when restoring
			// the checkpoint (i.e. the `git restore` command doesn't work
			// for empty commits).
			await fs.writeFile(path.join(baseDir, ".gitkeep"), "")
			await git.add(".")
			const commit = await git.commit("Initial commit")

			if (!commit.commit) {
				throw new Error("Failed to create initial commit")
			}

			log(`[initRepo] Initial commit: ${commit.commit}`)
		}

		const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"])
		const currentSha = await git.revparse(["HEAD"])

		const hiddenBranch = `roo-code-checkpoints-${taskId}`
		const branchSummary = await git.branch()

		if (!branchSummary.all.includes(hiddenBranch)) {
			await git.checkoutBranch(hiddenBranch, currentBranch) // git checkout -b <hiddenBranch> <currentBranch>
			await git.checkout(currentBranch) // git checkout <currentBranch>
		}

		return { currentBranch, currentSha, hiddenBranch }
	}
}
