import { memo, useState } from "react"

import { Package } from "@shofer/shared/package"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@src/components/ui"
import MarkdownBlock from "@src/components/common/MarkdownBlock"

interface AnnouncementProps {
	hideAnnouncement: () => void
}

/**
 * You must update the `latestAnnouncementId` in ShoferProvider for new
 * announcements to show to users. This new id will be compared with what's in
 * state for the 'last announcement shown', and if it's different then the
 * announcement will render. As soon as an announcement is shown, the id will be
 * updated in state. This ensures that announcements are not shown more than
 * once, even if the user doesn't close it themselves.
 */

const Announcement = ({ hideAnnouncement }: AnnouncementProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(true)

	// Latest CHANGELOG.md entry, captured at build time (see vite.config.ts).
	const changelog = Package.changelog?.trim()

	return (
		<Dialog
			open={open}
			onOpenChange={(open) => {
				setOpen(open)

				if (!open) {
					hideAnnouncement()
				}
			}}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("chat:announcement.title", { version: Package.version })}</DialogTitle>
				</DialogHeader>
				<div className="max-h-[60vh] overflow-y-auto pr-1 text-sm">
					{changelog ? (
						<MarkdownBlock markdown={changelog} />
					) : (
						<p className="text-vscode-descriptionForeground">{t("chat:announcement.noChangelog")}</p>
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default memo(Announcement)
