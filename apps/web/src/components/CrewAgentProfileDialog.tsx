import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export interface CrewAgentProfile {
  readonly name: string;
  readonly role: string | null;
  readonly avatarUrl: string | null;
}

type Request = {
  readonly mode: "add" | "edit";
  readonly initial: CrewAgentProfile;
  readonly resolve: (profile: CrewAgentProfile | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestCrewAgentProfile(
  mode: Request["mode"],
  initial: CrewAgentProfile,
): Promise<CrewAgentProfile | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { mode, initial, resolve } }));
}

function finish(profile: CrewAgentProfile | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(profile);
}

export function CrewAgentProfileDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <CrewAgentProfileDialog key={request.initial.name} request={request} /> : null;
}

const optional = (value: string) => (value.trim().length > 0 ? value.trim() : null);

function CrewAgentProfileDialog(props: { request: Request }) {
  const id = useId();
  const { initial, mode } = props.request;
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role ?? "");
  const [avatarUrl, setAvatarUrl] = useState(initial.avatarUrl ?? "");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length === 0) return;
            finish({ name: name.trim(), role: optional(role), avatarUrl: optional(avatarUrl) });
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === "add" ? "Add to crew" : "Edit crew agent"}</DialogTitle>
            <DialogDescription>
              Crew agents sit above your threads, like contacts.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Label className="flex flex-col items-stretch" htmlFor={`${id}-name`}>
                Name
                <Input
                  nativeInput
                  autoFocus
                  required
                  id={`${id}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Label>
              <Label className="flex flex-col items-stretch" htmlFor={`${id}-role`}>
                Role
                <Input
                  nativeInput
                  id={`${id}-role`}
                  placeholder="Main, Researcher, Sales…"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                />
              </Label>
              <Label className="flex flex-col items-stretch" htmlFor={`${id}-avatar`}>
                Avatar image URL
                <Input
                  nativeInput
                  id={`${id}-avatar`}
                  type="url"
                  placeholder="https://…"
                  value={avatarUrl}
                  onChange={(event) => setAvatarUrl(event.target.value)}
                />
              </Label>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim().length === 0}>
              {mode === "add" ? "Add to crew" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
