# AI Project Context - Product Editor

Business logic and operational context for AI agents.

## Purpose
The Product Editor is used to create printable photo layouts for various products (e.g., photo prints, cards, personalized items). It bridges the gap between digital photos and physical print production.

## Key Concepts

### Layouts
A layout is a JSON template defining one or more "frames" where user photos are placed. It also specifies the canvas dimensions in millimeters and pixels (DPI).

### Multi-Surface Products
Some products (like a folded card) have multiple "surfaces". The editor allows users to switch between these surfaces and place different photos on each.

### Export Flow
1. **Interactive Preview**: Users see a low-resolution representation in the browser.
2. **High-Resolution Export**: The backend `LayoutEngine` generates a production-ready PNG at the target DPI (usually 300) for printing.

## User Persona
- **Internal Ops**: Create and manage layout templates.
- **External Customers**: Use the editor via iframe embed to design their products.

## Design Aesthetic
The project uses a modern "Gen-Z" design style:
- Glassmorphism (blur, transparency).
- Vibrant gradients (violet, fuchsia, cyan).
- Bold typography and uppercase labels.
- Rounded corners (2xl, 3xl).
