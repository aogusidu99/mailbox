"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/locale-context";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const t = useT().login;
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, undefined);
  const error = state?.error === "required" ? t.required : state?.error === "invalid" ? t.invalid : state?.error;

  return (
    <form action={formAction} className="space-y-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">{t.email}</FieldLabel>
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">{t.password}</FieldLabel>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
      </FieldGroup>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t.submitting : t.submit}
      </Button>
    </form>
  );
}
