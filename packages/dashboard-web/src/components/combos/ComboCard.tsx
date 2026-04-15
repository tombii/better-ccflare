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
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-2">
					<div className="min-w-0 flex-1">
						<CardTitle className="text-base leading-snug">
							{combo.name}
						</CardTitle>
						{combo.description && (
							<p className="mt-1 text-sm text-muted-foreground line-clamp-2">
								{combo.description}
							</p>
						)}
					</div>
					<Switch checked={combo.enabled} onCheckedChange={onToggleEnabled} />
				</div>
			</CardHeader>
			<CardContent className="pt-0">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground">
							{slotCount} {slotCount === 1 ? "slot" : "slots"}
						</span>
						{assignedFamily && (
							<Badge variant="secondary" className="text-xs">
								{assignedFamily}
							</Badge>
						)}
					</div>
					<div className="flex items-center gap-1">
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
