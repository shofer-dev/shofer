import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { useShoferCreditBalance } from "@/components/ui/hooks/useShoferCreditBalance"
import { useExtensionState } from "@src/context/ExtensionStateContext"

export const ShoferBalanceDisplay = () => {
	const { data: balance } = useShoferCreditBalance()
	const { cloudApiUrl } = useExtensionState()

	if (balance === null || balance === undefined) {
		return null
	}

	const formattedBalance = balance.toFixed(2)
	const billingUrl = cloudApiUrl ? `${cloudApiUrl.replace(/\/$/, "")}/billing` : "https://app.shofer.dev/billing"

	return (
		<VSCodeLink href={billingUrl} className="text-vscode-foreground hover:underline whitespace-nowrap">
			${formattedBalance}
		</VSCodeLink>
	)
}
