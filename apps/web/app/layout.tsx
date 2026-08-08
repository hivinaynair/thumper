import { ClerkProvider, Show, UserButton } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Syne } from "next/font/google";
import Link from "next/link";
import { ClearStaleServiceWorkers } from "./components/clear-stale-service-workers";
import "./globals.css";

const display = Syne({
	subsets: ["latin"],
	variable: "--font-display",
	weight: ["600", "700", "800"],
});

const sans = IBM_Plex_Sans({
	subsets: ["latin"],
	variable: "--font-sans",
	weight: ["400", "500", "600"],
});

const mono = IBM_Plex_Mono({
	subsets: ["latin"],
	variable: "--font-mono",
	weight: ["400", "500"],
});

export const metadata: Metadata = {
	title: "Thumper",
	description: "Private high-quality audio downloads for friends and family",
};

const clerkAppearance = {
	baseTheme: dark,
	variables: {
		colorPrimary: "#C9963E",
		colorPrimaryForeground: "#1A1408",
		colorBackground: "#141414",
		colorForeground: "#EDE6DC",
		colorMutedForeground: "#A89A8C",
		colorInput: "#1B1B1B",
		colorInputForeground: "#EDE6DC",
		colorNeutral: "#5C5C5C",
		colorDanger: "#D4655A",
		colorModalBackdrop: "rgba(0, 0, 0, 0.72)",
		borderRadius: "6px",
	},
	elements: {
		card: {
			backgroundColor: "#141414",
			border: "1px solid rgba(92, 92, 92, 0.4)",
			boxShadow: "0 18px 48px rgba(0, 0, 0, 0.55)",
		},
		headerTitle: {
			color: "#EDE6DC",
		},
		headerSubtitle: {
			color: "#A89A8C",
		},
		socialButtonsBlockButton: {
			backgroundColor: "#1B1B1B",
			border: "1px solid rgba(92, 92, 92, 0.5)",
			color: "#EDE6DC",
		},
		socialButtonsBlockButtonText: {
			color: "#EDE6DC",
		},
		formButtonPrimary: {
			background:
				"linear-gradient(180deg, rgba(255,236,190,0.2) 0%, transparent 38%), linear-gradient(165deg, #DBB85A 0%, #C9963E 40%, #8F6A24 76%, #4A390F 100%)",
			color: "#1A1408",
			border: "none",
			borderRadius: "999px",
			boxShadow:
				"0 1px 0 rgba(255, 236, 190, 0.35) inset, 0 12px 28px rgba(0, 0, 0, 0.45), 0 0 34px rgba(201, 150, 62, 0.26)",
		},
		footerActionLink: {
			color: "#C9963E",
		},
		footer: {
			background: "transparent",
		},
		modalContent: {
			backgroundColor: "#141414",
		},
	},
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<ClerkProvider appearance={clerkAppearance}>
			<html lang="en">
				<body
					className={`${display.variable} ${sans.variable} ${mono.variable}`}
				>
					<ClearStaleServiceWorkers />
					<div className="shell">
						<header className="topbar">
							<Link href="/" className="brand">
								Thumper
							</Link>
							<nav>
								<Show when="signed-in">
									<Link href="/downloader">Downloader</Link>
									<Link href="/retag">Retag</Link>
									<UserButton
										userProfileProps={{
											additionalOAuthScopes: {
												google: [
													"https://www.googleapis.com/auth/drive.file",
												],
											},
										}}
									/>
								</Show>
							</nav>
						</header>
						{children}
					</div>
				</body>
			</html>
		</ClerkProvider>
	);
}
