# Legal & Intellectual Property Policy

## What This Project Is

This is a free, open-source, community-built alternative for browsing and interacting with standardised LED climbing training boards (Kilter Board, Tension Board, MoonBoard, and others). The app is free, the source is open, and the people who build it are volunteers. Boardsesh sells one optional thing — CNC build plans for a home wall, under a separate manufacturing licence — and that revenue pays for hosting and development.

We believe climbers should have the freedom to choose how they interact with hardware they've purchased, and that community-created data should remain accessible to the community.

---

## Our Position on Climb Data

### Climbs are factual data

A climb on a standardised board is a list of hold positions on a fixed, standardised layout (e.g. "start on A5, use B12, C3, D18, finish on K11"), combined with a grade and wall angle. This is factual, functional information — comparable to a chess position, a set of GPS coordinates, or a phone number — not a creative work of authorship.

Under U.S. copyright law, **facts are not copyrightable** (_Feist Publications, Inc. v. Rural Telephone Service Co._, 499 U.S. 340 (1991)). A standardised board with a finite number of holds (typically 200–500) produces climb definitions that are inherently constrained, factual, and functional.

### The database is community-created

The climb databases for these boards are almost entirely **user-generated content**. Individual climbers create and submit climbs. The board manufacturers did not author this content — they provide a platform for submission and display.

The licensing position varies by manufacturer, but in no case does a manufacturer own the community's climb data:

**Aurora Climbing** (Kilter Board, Tension Board, and others): Aurora's Terms of Use grant them a _"perpetual, unrestricted, unlimited, non-exclusive, irrevocable license"_ over user-submitted content ("Contributed Content"). Crucially, this license is **non-exclusive** — it does not transfer ownership to Aurora, nor does it prevent the original creator (or third parties) from independently using, collecting, or presenting the same factual data. A non-exclusive license grants the licensee the right to use the content; it does not grant standing to prevent others from doing the same.

**Moon Climbing** (MoonBoard): As of the last review of Moon Climbing's public-facing legal documents (February 2026), we did not find app-specific Terms of Service, an End User License Agreement, or a contributed-content license governing the MoonBoard app or its climb database — their website Terms and Conditions address e-commerce matters (shipping, returns, pricing) and their Privacy Policy addresses personal data under GDPR. As with the other boards, our position does not turn on any single manufacturer's terms: it rests on the factual, functional nature of climb definitions and the community-created nature of the databases (see above).

### Comprehensive databases have weak compilation protection

Even where a database _arrangement_ might qualify for thin copyright protection as a compilation, the U.S. Supreme Court has held that protection extends only to creative selection or arrangement — not to the underlying facts. A database that comprehensively collects _all_ user submissions without editorial curation (as these platforms do) is analogous to an alphabetical phone directory, which the Court found unprotectable in _Feist_.

---

## Attribution & Respect for Creators

We respect the climbing community and the people who create climbs.

- Where climb creator information is available, we attribute the creator by their username.
- We do not claim authorship of climbs we did not create.
- If you are the creator of a climb and would like it removed from this project, please open an issue or contact us and we will honour your request promptly.

---

## Interoperability & Hardware Compatibility

This project provides software and hardware designs that are compatible with standardised climbing board hardware. Climbers who have purchased these boards have a right to use third-party software and controllers with their own hardware.

### Software interoperability

Our app communicates with board controllers over standard Bluetooth protocols. The Bluetooth communication protocol used by these boards is unencrypted and based on commodity hardware (WS2812B addressable LEDs driven by standard Bluetooth controllers). Implementing a compatible Bluetooth interface for the purpose of interoperability is well-established as lawful under both U.S. and EU law (_Sega Enterprises Ltd. v. Accolade, Inc._, 977 F.2d 1510 (9th Cir. 1992); EU Directive 2009/24/EC, Article 6).

### Open-source controller

This project also offers open-source controller hardware and firmware designs. The controller is an independent, original implementation that communicates using the same Bluetooth protocol as the official controllers. It is built on commodity components (standard microcontrollers and WS2812B LEDs) and does not incorporate any proprietary firmware, code, or hardware designs from any board manufacturer. No patents are known to exist covering the LED controller systems used by any current board manufacturer.

Our controller is designed to be interoperable with both this project's software and, at the user's discretion, official manufacturer apps. Any such interoperability is initiated by the end user on their own hardware.

### Trademark usage

We use board and product names (e.g. "Kilter Board", "MoonBoard", "Tension Board") solely to describe hardware compatibility and interoperability. These names are trademarks of their respective owners. This project is not affiliated with, endorsed by, or sponsored by Aurora Climbing, Moon Climbing, or any board manufacturer.

---

## Build Plans

Boardsesh sells CNC build plans for a climbing home wall: a generated set of DXF cutting files, PDFs and a bill of materials for one wall, in the size and the manufacturing options the buyer picked.

What is sold is the generated pack, not the generator. The software that produces the plans is closed source and is not distributed; the app itself stays Apache 2.0 and free.

Each pack is generated individually for one order, carries its own licence id, and is licensed for one wall rather than sold outright. The terms are on the [build plans manufacturing licence](https://boardsesh.com/build-plans/licence) page.

The plans are compatible with the Kilter Homewall hole pattern. That is a statement about hole positions, not a relationship: Boardsesh is not affiliated with, endorsed by, or sponsored by Aurora Climbing or any board manufacturer. Holds, LED kits and app access are not part of a pack and are bought from the manufacturer.

The licence text is a draft pending review by an Australian IP lawyer, and build plans are not on sale until that review is done.

---

## Third-Party Notices

- **Person Falling icon** from [Font Awesome Free 6.7.2](https://fontawesome.com) by @fontawesome. License: [CC BY 4.0](https://fontawesome.com/license/free). Copyright 2024 Fonticons, Inc.

---

## DMCA & Takedown Requests

We take intellectual property concerns seriously. If you believe any material in this project infringes your copyright, please contact us with the following information:

1. Identification of the copyrighted work you believe is infringed.
2. Identification of the material you believe is infringing, with enough detail for us to locate it.
3. Your contact information (name, address, email, phone number).
4. A statement that you have a good faith belief that the use is not authorised by the copyright owner, its agent, or the law.
5. A statement, under penalty of perjury, that the information in your notice is accurate and that you are the copyright owner or authorised to act on their behalf.

We will review all valid requests promptly and in good faith. We may also file a counter-notice where we believe a takedown request is based on a misidentification of the material or a misunderstanding of the law.

**Contact:** legal@boardsesh.com

---

## A Note to the Community

The climbing community has a long tradition of openly sharing beta. This project exists in that spirit. We are not trying to harm any company — we are trying to give climbers better tools to interact with hardware they already own and data they helped create.

Manufacturers continue to benefit from this ecosystem. Our project drives demand for their physical products (holds, boards, panels) where they provide genuine value. We simply believe climbers deserve a choice in how they interact with their hardware.

If you are a board manufacturer and would like to discuss collaboration or have concerns, we welcome open dialogue. Please reach out.

---

_This document is provided for informational purposes and does not constitute legal advice. Last updated: 06-09-2026_
