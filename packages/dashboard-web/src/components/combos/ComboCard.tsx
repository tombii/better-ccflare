import type { Combo } from "@better-ccflare/types";
import { Edit, Trash2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Switch } from "../ui/switch";

interface ComboCardProps {
	combo: Combo;
	slotCount?: number;
	assignedFamily?: string | null;
	onEdit: () => void;
	onDelete: () => void;
	onToggleEnabled: (enabled: boolean) => void;
}

export function ComboCard({
	combo,
	slotCount = 0,
	assignedFamily,
	onEdit,
	onDelete,
	onToggleEnabled,
}: ComboCardProps) {
	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between">
					<CardTitle className="text-base">{combo.name}</CardTitle>
					<div className="flex items-center gap-2">
						{assignedFamily && (
							<Badge variant="default" className="text-xs">
								{assignedFamily}
							</Badge>
						)}
						<Switch
							checked={combo.enabled}
							onCheckedChange={onToggleEnabled}
							className="scale-75"
						/>
						<Badge variant={combo.enabled ? "default" : "secondary"}>
							{combo.enabled ? "Enabled" : "Disabled"}
						</Badge>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{combo.description && (
					<p className="text-sm text-muted-foreground mb-3">
						{combo.description}
					</p>
				)}
				<div className="flex items-center justify-between">
					<span className="text-sm text-muted-foreground">
						Slots: {slotCount}
					</span>
					<div className="flex gap-2">
						<Button variant="ghost" size="sm" onClick={onEdit}>
							<Edit className="h-4 w-4" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={onDelete}
							className="text-destructive hover:text-destructive"
						>
							<Trash2 className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
