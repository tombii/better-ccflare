import type { ComboFamily } from "@better-ccflare/types";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useAssignFamily, useCombos, useFamilies } from "../../hooks/queries";

const FAMILIES: ComboFamily[] = ["opus", "sonnet", "haiku"];

const FAMILY_LABELS: Record<ComboFamily, string> = {
	opus: "Opus",
	sonnet: "Sonnet",
	haiku: "Haiku",
};

export function FamilyActivationSection() {
	const combosQuery = useCombos();
	const familiesQuery = useFamilies();
	const assignFamily = useAssignFamily();

	const combos = combosQuery.data?.combos ?? [];
	const families = familiesQuery.data?.families ?? [];
	const enabledCombos = combos.filter((c) => c.enabled);

	const getFamilyAssignment = (family: ComboFamily) =>
		families.find((f) => f.family === family);

	const handleToggle = (family: ComboFamily, enabled: boolean) => {
		const assignment = getFamilyAssignment(family);
		assignFamily.mutate({
			family,
			comboId: assignment?.combo_id ?? null,
			enabled,
		});
	};

	const handleComboSelect = (family: ComboFamily, comboId: string) => {
		const assignment = getFamilyAssignment(family);
		assignFamily.mutate({
			family,
			comboId: comboId === "none" ? null : comboId,
			enabled: assignment?.enabled ?? true,
		});
	};

	if (familiesQuery.isLoading || combosQuery.isLoading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Family Activation</CardTitle>
					<CardDescription>Assign combos to model families</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">Loading...</p>
				</CardContent>
			</Card>
		);
	}

	if (familiesQuery.isError || combosQuery.isError) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Family Activation</CardTitle>
					<CardDescription>Assign combos to model families</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-destructive">Failed to load family data.</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Family Activation</CardTitle>
				<CardDescription>Assign combos to model families</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					{FAMILIES.map((family) => {
						const assignment = getFamilyAssignment(family);
						const isEnabled = assignment?.enabled ?? false;
						const activeComboId = assignment?.combo_id ?? null;

						return (
							<div key={family} className="flex items-center gap-4">
								<Label className="w-16 font-medium">{FAMILY_LABELS[family]}</Label>
								<Switch
									checked={isEnabled}
									onCheckedChange={(checked) => handleToggle(family, checked)}
									disabled={assignFamily.isPending}
								/>
								{isEnabled && (
									<Select
										value={activeComboId ?? "none"}
										onValueChange={(value) => handleComboSelect(family, value)}
										disabled={assignFamily.isPending}
									>
										<SelectTrigger className="w-48">
											<SelectValue placeholder="Select combo..." />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="none">None</SelectItem>
											{enabledCombos.map((combo) => (
												<SelectItem key={combo.id} value={combo.id}>
													{combo.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
								{isEnabled && activeComboId && (
									<Badge variant="default">Active</Badge>
								)}
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
