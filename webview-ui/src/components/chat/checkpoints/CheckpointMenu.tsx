import { useState, useEffect, useCallback } from "react"
import { DotsHorizontalIcon } from "@radix-ui/react-icons"

import { vscode } from "../../../utils/vscode"

import {
	Button,
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuShortcut,
} from "@/components/ui"

type CheckpointMenuProps = {
	ts: number
	commitHash: string
}

export const CheckpointMenu = ({ ts, commitHash }: CheckpointMenuProps) => {
	const [portalContainer, setPortalContainer] = useState<HTMLElement>()

	const onTaskDiff = useCallback(() => {
		vscode.postMessage({ type: "checkpointDiff", payload: { ts, commitHash, mode: "full" } })
	}, [ts, commitHash])

	const onCheckpointDiff = useCallback(() => {
		vscode.postMessage({ type: "checkpointDiff", payload: { ts, commitHash, mode: "checkpoint" } })
	}, [ts, commitHash])

	const onPreview = useCallback(() => {
		vscode.postMessage({ type: "checkpointRestore", payload: { ts, commitHash, mode: "preview" } })
	}, [ts, commitHash])

	const onRestore = useCallback(() => {
		vscode.postMessage({ type: "checkpointRestore", payload: { ts, commitHash, mode: "restore" } })
	}, [ts, commitHash])

	useEffect(() => {
		// The dropdown menu uses a portal from @shadcn/ui which by default renders
		// at the document root. This causes the menu to remain visible even when
		// the parent ChatView component is hidden (during settings/history view).
		// By moving the portal inside ChatView, the menu will properly hide when
		// its parent is hidden.
		setPortalContainer(document.getElementById("chat-view-portal") || undefined)
	}, [])

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon">
					<DotsHorizontalIcon />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent container={portalContainer} align="end">
				<DropdownMenuItem onClick={onCheckpointDiff}>
					<div className="flex flex-row-reverse gap-1">
						<span>Checkpoint Diff</span>
						<DropdownMenuShortcut>
							<span className="codicon codicon-diff-single" />
						</DropdownMenuShortcut>
					</div>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onTaskDiff}>
					<div className="flex flex-row-reverse gap-1">
						<span>Task Diff</span>
						<DropdownMenuShortcut>
							<span className="codicon codicon-diff-multiple" />
						</DropdownMenuShortcut>
					</div>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onPreview}>
					<div className="flex flex-row-reverse gap-1">
						<span>Preview</span>
						<DropdownMenuShortcut>
							<span className="codicon codicon-open-preview" />
						</DropdownMenuShortcut>
					</div>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onRestore}>
					<div className="flex flex-row-reverse gap-1">
						<span>Restore</span>
						<DropdownMenuShortcut>
							<span className="codicon codicon-history" />
						</DropdownMenuShortcut>
					</div>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
