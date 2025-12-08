# Generative UI Scenarios

10 realistic scenarios demonstrating how users create and interact with generated interfaces.

---

## 1. Quick Expense Tracker

**Context**: Freelancer needs to track project expenses on the go without installing an app.

**Prompts**:
1. "Create an expense tracker with categories: travel, food, supplies, software"
2. "Add a monthly total at the bottom"
3. "Let me filter by category"

**Actions**:
- add-expense: {amount: 45.50, category: "food", description: "Client lunch"}
- add-expense: {amount: 120, category: "software", description: "Figma subscription"}
- filter: {category: "travel"}
- delete: {id: "exp-3"}
- add-expense: {amount: 89, category: "travel", description: "Uber to meeting"}

**Pattern**: 3 prompts → 50+ actions over time

---

## 2. Interview Question Bank

**Context**: Hiring manager preparing for technical interviews.

**Prompts**:
1. "Create a question bank for frontend developer interviews with difficulty ratings"
2. "Add a 'used' checkbox so I don't repeat questions"
3. "Group questions by topic: React, CSS, JavaScript, System Design"

**Actions**:
- add-question: {text: "Explain React's reconciliation algorithm", difficulty: "hard", topic: "React"}
- add-question: {text: "What is specificity in CSS?", difficulty: "easy", topic: "CSS"}
- toggle-used: {id: "q-1"}
- toggle-used: {id: "q-4"}
- filter: {topic: "JavaScript", difficulty: "medium"}
- toggle-used: {id: "q-7"}
- reorder: {id: "q-3", position: 0}

**Pattern**: 3 prompts → heavy action usage during interview prep sessions

---

## 3. Recipe Scaling Calculator

**Context**: Home cook doubling a recipe for a dinner party.

**Prompts**:
1. "Create a recipe ingredient scaler - I enter ingredients and servings, it calculates new amounts"
2. "Add a shopping list that combines scaled ingredients"

**Actions**:
- add-ingredient: {name: "flour", amount: 2, unit: "cups", servings: 4}
- add-ingredient: {name: "sugar", amount: 0.5, unit: "cups", servings: 4}
- add-ingredient: {name: "eggs", amount: 3, unit: "whole", servings: 4}
- set-target-servings: {servings: 12}
- add-to-shopping-list: {id: "ing-1"}
- add-to-shopping-list: {id: "ing-2"}
- add-to-shopping-list: {id: "ing-3"}
- clear-recipe: {}

**Pattern**: 2 prompts → repeated use for different recipes

---

## 4. Sprint Retrospective Board

**Context**: Scrum master running a remote retro without dedicated tooling.

**Prompts**:
1. "Create a retro board with three columns: What went well, What didn't, Action items"
2. "Add voting - team members can upvote items"
3. "Add an 'owner' field to action items"

**Actions**:
- add-card: {column: "well", text: "Daily standups were efficient"}
- add-card: {column: "didnt", text: "Too many meetings on Wednesday"}
- add-card: {column: "didnt", text: "Deployment pipeline broke twice"}
- upvote: {id: "card-2"}
- upvote: {id: "card-2"}
- upvote: {id: "card-3"}
- add-card: {column: "actions", text: "Implement deployment tests"}
- set-owner: {id: "card-5", owner: "Sarah"}
- archive-column: {column: "well"}

**Pattern**: 3 prompts → burst of actions during meeting, then dormant

---

## 5. Workout Timer

**Context**: Gym-goer creating a custom HIIT routine.

**Prompts**:
1. "Create an interval timer for HIIT - I need work periods, rest periods, and rounds"
2. "Add sound alerts when switching"
3. "Let me save and name different routines"

**Actions**:
- set-work-time: {seconds: 40}
- set-rest-time: {seconds: 20}
- set-rounds: {count: 8}
- start: {}
- pause: {}
- resume: {}
- reset: {}
- save-routine: {name: "Morning HIIT"}
- load-routine: {name: "Morning HIIT"}
- start: {}

**Pattern**: 3 prompts → same routine reused dozens of times

---

## 6. Client Feedback Collector

**Context**: Designer gathering feedback on mockups during a client call.

**Prompts**:
1. "Create a feedback form with sections for each screen: Homepage, Pricing, Contact"
2. "Add priority tags: must-fix, nice-to-have, out-of-scope"
3. "Add a 'resolved' status I can check off"

**Actions**:
- add-feedback: {screen: "Homepage", text: "Logo too small", priority: "must-fix"}
- add-feedback: {screen: "Homepage", text: "Add testimonials section", priority: "nice-to-have"}
- add-feedback: {screen: "Pricing", text: "Clarify enterprise tier", priority: "must-fix"}
- add-feedback: {screen: "Contact", text: "Add phone number", priority: "out-of-scope"}
- toggle-resolved: {id: "fb-1"}
- change-priority: {id: "fb-2", priority: "must-fix"}
- toggle-resolved: {id: "fb-3"}
- filter: {priority: "must-fix", resolved: false}

**Pattern**: 3 prompts → rapid actions during call, then tracking over days

---

## 7. Packing Checklist Generator

**Context**: Traveler preparing for a week-long business trip.

**Prompts**:
1. "Create a packing checklist for a business trip with categories: clothes, toiletries, electronics, documents"
2. "Add quantity field for clothes items"
3. "Add a 'packed' checkbox for each item"

**Actions**:
- add-item: {category: "clothes", name: "Dress shirts", quantity: 5}
- add-item: {category: "clothes", name: "Pants", quantity: 3}
- add-item: {category: "electronics", name: "Laptop charger", quantity: 1}
- add-item: {category: "documents", name: "Passport", quantity: 1}
- toggle-packed: {id: "item-1"}
- toggle-packed: {id: "item-4"}
- toggle-packed: {id: "item-2"}
- add-item: {category: "toiletries", name: "Toothbrush", quantity: 1}
- toggle-packed: {id: "item-5"}

**Pattern**: 3 prompts → checklist interactions over 1-2 days before trip

---

## 8. Meeting Cost Calculator

**Context**: Manager demonstrating meeting costs to encourage efficiency.

**Prompts**:
1. "Create a meeting cost calculator - input attendees, their hourly rates, and meeting duration"
2. "Show running cost that updates live during the meeting"
3. "Add a 'decisions made' counter to show ROI"

**Actions**:
- add-attendee: {name: "Alice", rate: 75}
- add-attendee: {name: "Bob", rate: 85}
- add-attendee: {name: "Carol", rate: 120}
- add-attendee: {name: "Dave", rate: 65}
- start-meeting: {}
- add-decision: {text: "Approved Q2 budget"}
- add-decision: {text: "Selected vendor for project X"}
- end-meeting: {}
- remove-attendee: {id: "att-4"}
- start-meeting: {}

**Pattern**: 3 prompts → used repeatedly for different meetings

---

## 9. A/B Test Results Tracker

**Context**: Product manager tracking multiple experiments without a full analytics tool.

**Prompts**:
1. "Create an A/B test tracker with test name, variants A and B, and conversion rates"
2. "Add statistical significance indicator"
3. "Add status: running, paused, concluded"

**Actions**:
- add-test: {name: "CTA Button Color", variantA: "Blue", variantB: "Green"}
- update-metrics: {id: "test-1", conversionsA: 145, visitorsA: 1000, conversionsB: 167, visitorsB: 1000}
- add-test: {name: "Headline Copy", variantA: "Save Time", variantB: "Save Money"}
- update-metrics: {id: "test-2", conversionsA: 89, visitorsA: 500, conversionsB: 92, visitorsB: 500}
- set-status: {id: "test-1", status: "concluded"}
- update-metrics: {id: "test-2", conversionsA: 178, visitorsA: 1000, conversionsB: 201, visitorsB: 1000}
- add-test: {name: "Pricing Display", variantA: "$99/mo", variantB: "$1188/yr"}

**Pattern**: 3 prompts → daily metric updates over weeks

---

## 10. Personal OKR Dashboard

**Context**: Individual contributor tracking quarterly goals.

**Prompts**:
1. "Create an OKR tracker with objectives and 3 key results each, with progress percentages"
2. "Add weekly check-in notes for each key result"
3. "Show overall objective progress as average of key results"

**Actions**:
- add-objective: {title: "Improve code quality"}
- add-key-result: {objectiveId: "obj-1", title: "Reduce bug count by 30%", target: 30}
- add-key-result: {objectiveId: "obj-1", title: "Increase test coverage to 80%", target: 80}
- add-key-result: {objectiveId: "obj-1", title: "Complete 5 code reviews per week", target: 100}
- update-progress: {id: "kr-1", current: 15}
- add-checkin: {id: "kr-1", note: "Fixed 3 critical bugs this week"}
- update-progress: {id: "kr-2", current: 72}
- add-checkin: {id: "kr-2", note: "Added tests for auth module"}
- update-progress: {id: "kr-1", current: 28}
- update-progress: {id: "kr-3", current: 60}

**Pattern**: 3 prompts → weekly progress updates over quarter

---

## Summary Statistics

| Scenario | Prompts | Actions (typical session) | Reuse Pattern |
|----------|---------|---------------------------|---------------|
| Expense Tracker | 3 | 5-10 per day | Daily over months |
| Interview Questions | 3 | 10-20 per session | Weekly bursts |
| Recipe Scaler | 2 | 8-12 per recipe | Weekly |
| Retro Board | 3 | 15-25 per meeting | Bi-weekly |
| Workout Timer | 3 | 5-8 per workout | Daily |
| Feedback Collector | 3 | 10-15 per call | Per project |
| Packing Checklist | 3 | 15-20 per trip | Monthly |
| Meeting Calculator | 3 | 6-10 per meeting | Daily |
| A/B Test Tracker | 3 | 3-5 per day | Daily over weeks |
| OKR Dashboard | 3 | 8-12 per week | Weekly over quarter |

**Key Insight**: Average 2-3 prompts to create, then 5-25 actions per session. Prompts front-loaded, actions dominate ongoing usage.
