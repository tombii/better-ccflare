import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

export function CombosTab() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Combos Management</CardTitle>
				<CardDescription>
					Define fallback chains for model families
				</CardDescription>
			</CardHeader>
			<CardContent>
				<p className="text-muted-foreground">
					Combo management UI will be implemented in subsequent tasks
				</p>
			</CardContent>
		</Card>
	);
}