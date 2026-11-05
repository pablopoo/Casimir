import {
  useEffect,
  useState,
  type FormHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  formErrorMessage,
  formRetryMessage,
  formSubmissionBlocked,
  scheduleFormRetry,
  type FormModel,
  type FormMethod,
  type VoidActionError,
} from 'void/pages-client';

export type FormProps = Omit<
  FormHTMLAttributes<HTMLFormElement>,
  'action' | 'onSubmit' | 'method' | 'onError'
> & {
  form: FormModel<[FormData]>;
  method?: FormMethod;
  renderError?: (error: VoidActionError) => ReactNode;
};

export function Form({
  form,
  method = 'post',
  renderError,
  children,
  ...props
}: FormProps): ReactElement {
  const [now, setNow] = useState(Date.now);
  useEffect(() => scheduleFormRetry(form.error, () => setNow(Date.now())), [form.error]);
  const message = formErrorMessage(form);
  const retry = formRetryMessage(form.error);
  const blocked = formSubmissionBlocked(form, now);
  return (
    <form
      {...props}
      action={form[method]}
      aria-busy={form.pending}
      onSubmit={(event) => {
        if (blocked) {
          event.preventDefault();
        }
      }}
    >
      {message && (
        <div role="alert" data-void-form-error>
          {form.error && renderError ? renderError(form.error) : message}
          {retry && <p>{retry}</p>}
        </div>
      )}
      {children}
    </form>
  );
}
