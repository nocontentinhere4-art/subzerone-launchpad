-- SUB-01's feedback on every verdict (feedback.js): what he liked, what he did not, what he would change, and when he
-- would build it. Written in the same transaction as the decision, from the scorecard rules that fired and the brain
-- vote's networks; an optional language-model polish updates the same row later (feedback_json.polished).
-- latency_ms: from the moment that idea version was dropped to the verdict, as the author feels it.
ALTER TABLE evaluations ADD COLUMN feedback_json TEXT;
ALTER TABLE evaluations ADD COLUMN latency_ms INTEGER;
