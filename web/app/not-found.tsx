import { AddressForm } from "@/components/address-form.tsx";

export default function NotFound() {
  return (
    <section className="tool wrap">
      <h1>There is no page here. Paste an address instead.</h1>
      <AddressForm />
    </section>
  );
}
