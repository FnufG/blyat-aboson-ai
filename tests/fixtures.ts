import type { KnowledgeEntry } from "../lib/types";

// Test-only source material. The application starts without seeded knowledge.
export const testKnowledge: KnowledgeEntry[] = [
  { id: "faq-1", title: "What devices does support cover?", content: "Support covers the TL-100 router. Other device models are not documented." },
  { id: "faq-2", title: "What are support opening hours?", content: "Support is open Monday through Friday from 09:00 to 18:00." },
  { id: "faq-3", title: "How can I contact support?", content: "Email support@example.invalid. Replies arrive within two working days." },
  { id: "faq-4", title: "What are the warranty terms for the TL-100 router?", content: "The TL-100 warranty lasts 12 months from purchase. Keep proof of purchase." },
  { id: "faq-5", title: "Can I return the router?", content: "Contact support with your order number to ask about returns." },
  { id: "faq-6", title: "How do I set up the TL-100 router?", content: "Connect the provider cable to WAN and follow the printed setup guide." },
  { id: "faq-7", title: "Why is the router indicator blinking red?", content: "A blinking red indicator means the router has no provider connection. Check the WAN cable, then restart the router." },
  { id: "faq-8", title: "Why is the internet connection unavailable?", content: "Check the provider cable and contact the provider about any outage." },
  { id: "faq-9", title: "I forgot my Wi-Fi password", content: "Check the Wi-Fi password printed on the device label if you have not changed it." },
  { id: "faq-10", title: "How do I update router firmware?", content: "Only install firmware supplied by support for your exact device model." },
  { id: "faq-11", title: "How do I improve a weak Wi-Fi signal?", content: "Place the router centrally, away from metal objects and thick walls." },
  { id: "faq-12", title: "How do I restart the router?", content: "Unplug power for 30 seconds, reconnect it and wait two minutes." },
  { id: "faq-13", title: "How do I reset router settings?", content: "A factory reset removes your configuration. Contact support before resetting." },
  { id: "faq-14", title: "The router has no power", content: "Check the power adapter and the wall socket." },
  { id: "faq-15", title: "How long does delivery take?", content: "Delivery takes three working days after order confirmation." },
  { id: "faq-16", title: "Which payment methods are accepted?", content: "Orders can be paid by bank card." },
  { id: "faq-17", title: "How do I get a receipt?", content: "Email billing@example.invalid with your order number." },
  { id: "faq-18", title: "How do I keep my account secure?", content: "Use a unique password and never share verification codes." },
];
