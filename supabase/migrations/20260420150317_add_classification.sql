-- Add classification column to thoughts table
-- Values: 'personal', 'work'
-- Default: 'personal'
ALTER TABLE public.thoughts ADD COLUMN IF NOT EXISTS classification TEXT DEFAULT 'personal';

-- Create an index for faster filtering
CREATE INDEX IF NOT EXISTS idx_thoughts_classification ON public.thoughts (classification);

-- Update existing thoughts to 'personal' (should already be done by DEFAULT, but just in case)
UPDATE public.thoughts SET classification = 'personal' WHERE classification IS NULL;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
