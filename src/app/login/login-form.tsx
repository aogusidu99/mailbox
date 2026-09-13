"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, undefined);

  return (
    <form action={formAction} className="space-y-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">邮箱</FieldLabel>
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">密码</FieldLabel>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </Field>
        {state?.error ? <FieldError>{state.error}</FieldError> : null}
      </FieldGroup>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "登录中…" : "登录"}
      </Button>
    </form>
  );
}
