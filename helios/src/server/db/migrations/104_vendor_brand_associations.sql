-- Migration 104: normalized vendors and their usually-exclusive brand associations.
--
-- Cost/index strategy: these CRUD tables are tiny (84 seeded vendors and 232
-- associations). Case-insensitive vendor/brand lookups use expression indexes
-- on lower(name); writes maintain only the PK/FK and load-bearing uniqueness
-- indexes. There is no polling, scheduled job, backfill, or background workload.
-- The seed is deterministic and conflict-do-nothing so a retry cannot overwrite
-- later operator edits.

\set ON_ERROR_STOP on
\timing on

\echo 'Running migration 104: vendor brand associations...'

begin;
set local lock_timeout = '5s';

create table if not exists vendors (
  id bigint generated always as identity primary key,
  name text not null,
  is_mso boolean not null default false,
  is_micro boolean not null default false,
  cod_only boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendors_name_trimmed_nonempty_check check (name = btrim(name) and name <> '')
);

create unique index if not exists vendors_name_lower_uidx on vendors (lower(name));

create table if not exists vendor_brand_associations (
  id bigint generated always as identity primary key,
  vendor_id bigint not null references vendors(id) on delete cascade,
  brand_name text not null,
  is_primary boolean not null default true,
  target_days_on_hand integer,
  asset_url text,
  cod_required boolean,
  cod_discount_source text,
  minimum_order_dollars numeric(12,2),
  comments text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_brand_associations_brand_trimmed_nonempty_check
    check (brand_name = btrim(brand_name) and brand_name <> ''),
  constraint vendor_brand_associations_target_days_check
    check (target_days_on_hand is null or target_days_on_hand > 0),
  constraint vendor_brand_associations_asset_url_check
    check (asset_url is null or (asset_url = btrim(asset_url) and asset_url <> '')),
  constraint vendor_brand_associations_cod_discount_source_check
    check (cod_discount_source is null or (cod_discount_source = btrim(cod_discount_source) and cod_discount_source <> '')),
  constraint vendor_brand_associations_minimum_order_check
    check (minimum_order_dollars is null or minimum_order_dollars >= 0),
  constraint vendor_brand_associations_comments_check
    check (comments is null or (comments = btrim(comments) and comments <> ''))
);

create unique index if not exists vendor_brand_associations_vendor_brand_lower_uidx
  on vendor_brand_associations (vendor_id, lower(brand_name));
create unique index if not exists vendor_brand_associations_one_primary_brand_uidx
  on vendor_brand_associations (lower(brand_name)) where is_primary;

create temporary table vendor_seed_stage (
  source_order bigint generated always as identity,
  brand text,
  vendor_name text,
  target_days_on_hand integer,
  asset_url text,
  cod_text text,
  cod_discount_source text,
  minimum_order_dollars numeric(12,2),
  comments text
) on commit drop;

copy vendor_seed_stage
  (brand, vendor_name, target_days_on_hand, asset_url, cod_text,
   cod_discount_source, minimum_order_dollars, comments)
from stdin with (format csv, header true);
Brand,Vendor Name,Time to keep on hand,Assets,COD?,COD Discount?,Minimum Order,Comments
Mind Melters,All In One,18,,,,,
&Shine,"Fiorello Pharmaceuticals, Inc. dba GTI NY",18,,,,,
Smoke,Omnium Health Inc DBA MF Headhouse LLC,18,,,,,
Tical,BCD Innovation LLC,18,,,,,
Quality Control,BCD Innovation LLC,18,,,,,
Moodz,BCD Innovation LLC,18,,,,,
Stone Road,HR Botanical Distributor LLC,18,,,,,
Mountain High,BCD Innovation LLC,18,,,,,
Harney Brothers,Harney Brothers,18,,,,,
Presidente,lobocanna,18,,,,,
Cali Honey,BCD Innovation LLC,18,,,,,
Enigma,BCD Innovation LLC,18,,,,,
House of Sacci,House of Sacci,18,,,,,
Glenna's,Glenna & Co,18,,,,,
Fuerte,lobocanna,18,,,,,
Dumbo Electric,Dumbo Electric,18,,No,No,0,Case sizes are 25 and 50
Presidential,Dumbo Electric,18,,No,$0.50,1000,COD discount is per unit.  Case sizes are 20
Hashish,lobocanna,18,,,,,
Feels,Smoakland New York,9,,,,,
1906,"Hudson Valley Hemp Company, LLC",18,,,,,
1906,"Hudson Valley Hemp Company, LLC",18,,,,,
1937,Vireo Health of NY - Processing,18,,,,,
Boukèt,Vireo Health of NY - Processing,18,,,,,
1937,Vireo Health of NY - Processing,18,,,,,
2JS,Adonis,18,,,,,
40 Tons,HPI Canna Inc,18,,,,,
5 Boro,Nanticoke Hemp Inc. Distribution LLC,18,,,,,
7 Seaz,"Hepworth Ag, Inc",18,,,,,
Select,Curaleaf,18,,,,,
Airo,Hemp Hunter Labs Inc.,18,,,,,
Animal,"Hepworth Ag, Inc",18,,,,,
Anthem,Curaleaf,18,,,,,
Lip Service,HPI Canna Inc,18,,,,,
Aster,Scotch Valley Ranch Hemp LLC,18,,,,,
Ayrloom,"Gen V Labs, LLC",18,,,,,
Aeterna,Aeterna,18,,,,,
Bonanza,Bonanza,18,,,,,
B Noble,Curaleaf,18,,,,,
Blotter,NYHO Labs,18,https://brandfolder.com/cannabisbrandassets/farmer-group,,,,
Camino,Hemp Hunter Labs Inc.,18,,,,,
Canna Cure,"Canna Cure Farms, LLC",18,,,,,
Cannatella,UrbanXtracts,18,,,,,
Cheeba Chews,HPI Canna Inc,18,,,,,
Chef For Higher,HPI Canna Inc,18,,,,,
Cookies,"Hepworth Ag, Inc",18,,,,,
CRU,Empire Standard,18,,,,,
High Garden,Empire Standard,18,,,,,
Dank,HPI Canna Inc,18,,,,,
Dealer,All In One,18,,,,,
District 7,All In One,18,,,,,
Dompen,"Hepworth Ag, Inc",18,,,,,
Dr. Jekyll And Mr. High,Moony Zooties,9,,,,,
Drew Martin,HPI Canna Inc,18,,,,,
drip,"Central Processors NY, LLC",18,,,,,
Eaton,Nowave,18,,,,,
Effects,Big Sky Ranch LLC,18,,,,,
Electraleaf,Lifted NY Corp,18,,,,,
Eureka,HPI Canna Inc,18,,,,,
Evol by Future,Flowerhouse Walden LLC,18,,,,,
Fernway,NY Hemp Source LLC,18,,,,,
Find.,Curaleaf,18,,,,,
Flamer,Janes Garden,18,,,,,
Florist Farms,NYHO Labs,18,https://brandfolder.com/cannabisbrandassets/farmer-group,,,,
FlowerHouse,Flowerhouse Walden LLC,18,,,,,
FlowerHouse New York,Flowerhouse Walden LLC,18,,,,,
Freshly Baked NYC,Everything Branded,18,,,,,
Hepworth,"Hepworth Ag, Inc",18,,,,,
Generic AF,"Central Processors NY, LLC",18,,,,,
Golden Garden,Capital Region Co Inc.,18,,,,,
Good Green,"Fiorello Pharmaceuticals, Inc. dba GTI NY",18,,,,,
Good Times New York,HPI Canna Inc,18,,,,,
Goodlyfe,Moby & Zeke,18,,,,,
Grass Roots,Curaleaf,18,,,,,
Hashtag Honey,BCD Innovation LLC,18,,,,,
Head & Heal,NYHO Labs,18,,,,,
Head Space,All In One,18,,,,,
Heavy Hitters,NYHO Labs,18,,,,,
Her Highness,HPI Canna Inc,18,,,,,
HGNY,???,18,,,,,
HiColor,Vireo Health of NY - Processing,18,,,,,
Operator,Vireo Health of NY - Processing,18,,,,,
High Falls Canna New York,HV Ag Corp,18,,,,,
High Peaks,"Central Processors NY, LLC",18,,,,,
High Skrapers,"Sugarhouse Farms, LLC",18,,,,,
Holiday,"Hudson Valley Hemp Company, LLC",18,,,,,
Holiday Vapes,"Hudson Valley Hemp Company, LLC",18,,,,,
HoneyBee Collective,"Hepworth Ag, Inc",18,,,,,
Hudson Cannabis,"Hudson Valley Hemp Company, LLC",18,,,,,
Hysteria,All In One,18,,,,,
Incredibles,"Fiorello Pharmaceuticals, Inc. dba GTI NY",18,,,,,
Ithaca Cultivated,Donna E Halloran,18,,,,,
JAMS,Curaleaf,18,,,,,
Jaunty,Naturae New York Cannabis,18,,,,,
Jenny's,Jenny's Baked At Home,18,,,,,
Jetpacks,Empire Standard,18,,,,,
Jetty,Cirona Labs,18,,,,,
Kahuna Ice,NY Hemp Source LLC,18,,,,,
Kickfly's,"Hepworth Ag, Inc",18,,,,,
Kiva,Hemp Hunter Labs Inc.,18,,,,,
KOA,"Hepworth Ag, Inc",18,,,,,
KushKards,Freshly Baked NYC,18,,,,,
Leal,Moby & Zeke,18,,,,,
LEVEL,NYHO Labs,18,https://brandfolder.com/cannabisbrandassets/farmer-group,,,,
LITTLES,Empire Standard,18,,,,,
Lobo,lobocanna,18,,,,,
Minis,lobocanna,18,,,,,
Bold,lobocanna,18,,,,,
Lost Farm,Hemp Hunter Labs Inc.,18,,,,,
Love Oui'd,Bristol Extracts LLC,18,,,,,
Luci,Nowave,18,,,,,
MFNY,MFNY Processor LLC,18,,,,,
Mfused,Omnium Health Inc DBA MF Headhouse LLC,18,,,,,
Miss Grass,"Hepworth Ag, Inc",18,,,,,
Mixed Light,Flo Extracts LLC,18,,,,,
MyHi,TruCann,18,,,,,
Nama,Basin Mixtures INC,18,,,,,
Nanticoke,Nanticoke Hemp Inc. Distribution LLC,18,,,,,
NY Finca,Nowave,18,,,,,
Off Hours,Nowave,18,,,,,
oHHo,Nanticoke Hemp Inc. Distribution LLC,18,,,,,
Old Pal,"Hepworth Ag, Inc",18,,,,,
OLIO,UrbanXtracts,18,,,,,
Ooze,Ooze,18,,,,,
Packs,HPI Canna Inc,18,,,,,
PAX,NY Hemp Source LLC,18,,,,,
Platinum Reserve,HPI Canna Inc,18,,,,,
Puff,"Hepworth Ag, Inc",18,,,,,
Pura,"Hepworth Ag, Inc",18,,,,,
Pure Bliss,"Sugarhouse Farms, LLC",18,,,,,
Pure Vibe,All In One,18,,,,,
Raven's View Genetics,Ravens View Genetics (Flower),18,,,,,
Ravens View Genetics,Ravens View Genetics (Flower),18,,,,,
Real Life Botanicals,Halton Hay INC. d/b/a ReaLife Botanicals,18,,,,,
Revert,Capital Region Co Inc.,18,,,,,
Revert Cannabis,Capital Region Co Inc.,18,,,,,
Rolling Green,Greener Standards Inc.,18,,,,,
Rove,"Hudson Valley Hemp Company, LLC",18,,,,,
Ruby Farms,??,18,,,,,
Rythm,"Fiorello Pharmaceuticals, Inc. dba GTI NY",18,,,,,
Sapphire,Moby & Zeke,18,,,,,
Scandalous,NYHO Labs,18,,,,,
Senior Moments,Bristol Extracts LLC,18,,,,,
Silly Nice,Veteran's holdings,18,,,,,
Slap That Ass Exotics,Torrwood Farm LLC,18,,,,,
Smoakland,Smoakland New York,9,,,,,
Smokiez,Glenna & Co,18,,,,,
Smokiez Edibles,Glenna & Co,18,,,,,
Snobby,Bristol Extracts LLC,18,,,,,
Snobby Dankins,Bristol Extracts LLC,18,,,,,
Soft Power Sweets,"Hepworth Ag, Inc",18,,,,,
SunDrift,"Hepworth Ag, Inc",18,,,,,
Super J,Smoakland New York,9,,,,,
The Botanist,NYCANNA LLC,18,,,,,
The Plug Pack,Omnium Health,18,,,,,
Toast,"Hepworth Ag, Inc",18,,,,,
TOKE,Big Yield Growers LLC (BYG LLC),18,,,,,
Torch,HPI Canna Inc,18,,,,,
TUNE,NYHO Labs,18,https://brandfolder.com/cannabisbrandassets/farmer-group,,,,
Tyson 2.0,"Hudson Valley Hemp Company, LLC",18,,,,,
Untitled,Empire Standard,18,,,,,
Upstate Retreat,Ravens View Genetics (Flower),18,,,,,
Verde Lucido,Lunulata,18,,,,,
Wana,NY Hemp Source LLC,18,,,,,
Weed Water,Nowave,18,,,,,
Weekenders,Torrwood Farm LLC,18,,,,,
WYLD,California Fragance Company Inc,18,,,,,
Zizzle,ZIZ NY GRW LLC,18,,,,,
Alibi,Nanticoke Hemp Inc. Distribution LLC,18,,,,,
Gentlemen Smugglers,Nanticoke Hemp Inc. Distribution LLC,18,,,,,
Back Home Farm,Nanticoke Hemp Inc. Distribution LLC,18,,,,,
Moony's,Moony Zooties,9,,,,,
Jekyll & High,Moony Zooties,9,,,,,
Booty Shake,Moony Zooties,9,,,,,
Alter,BCD Innovation LLC,18,,,,,
Continental exotics,BCD Innovation LLC,18,,,,,
Enigma,BCD Innovation LLC,18,,,,,
Highsman,BCD Innovation LLC,18,,,,,
Lowell,Hudson Cannabis Distribution,18,,,,,
The Green Lady,The Green Lady,18,,,,,
Native Nations Cannabis,Native Nations Cannabis,18,,,,,
Jive,Native Nations Cannabis,18,,,,,
Beezy Beez Honey,Beezy Beez Honey,18,,,,,
Honey King,Honey King,18,,,,,
Kings & Queens,Vireo Health of NY - Processing,18,,,,,
So Dope,"Hepworth Ag, Inc",18,,,,,
Herb,1Off,18,,,,,
Ichi Roll,Picc,18,,,,,
Moonlit Hash Co,1Off,18,,,,,
Smartbud,1Off,18,,,,,
Country Cannabis,Country Cannabis,18,,,,,
Mega,Mega,18,,,,,
Smack,Picc,18,,,,,
O-YEAH!,Picc,18,,,,,
ACO,Veteran's holdings,18,,,,,
Outrankd,Adonis,18,,,,,
Sushi Hash,Picc,18,,,,,
Cornucopia Growers,Cornucopia Growers,18,,,,,
Purps,1Off,18,,,,,
Friends With Flower,Adonis,18,,,,,
State of Mind,Picc,18,,,,,
Weedubest,Weedubest,18,,,,,
Sluggers,HPI Canna Inc,18,,,,,
A Walk In The Pines,Adonis,18,,,,,
Natural Xotics,Adonis,18,,,,,
Gypsy Weed,Gypsy Weed,18,,,,,
#Juan Roll,Picc,18,,,,,
The Gram,Adonis,18,,,,,
American Hash Maker,Adonis,18,,,,,
Chopsticks,Picc,18,,,,,
Bytes,Adonis,18,,,,,
Yem,Trico NY,18,,,,,
Doobie Labs,1Off,18,,,,,
Nyce,Nyce,18,,,,,
Stash Queens,"Hepworth Ag, Inc",18,,,,,
Blizzard,Adonis,18,,,,,
Kiefin it real,Adonis,18,,,,,
LEFT COAST,LEFT COAST,18,,No,,0,
167,Dumbo Electric,18,,No,,0,case size 25
Datz Packs,Dumbo Electric,18,,No,,0,case size 25
Capicu Exotics,Dumbo Electric,18,,No,,0,case size 10
Brick,Dumbo Electric,18,,No,16.67%,0,"These are blunts, normally 12, but COD is 10.  Case size is 100"
Aloha Waves,Dumbo Electric,18,,No,0,0,Cases are 25
Layup,Cannabals,18,,,5%,,
Cannabals,Cannabals,18,,,,,
Kingsroad,Cannabals,18,,,,,
Stiiizy,Stiiizy,18,,,,,
Dolla Trees,Dolla Trees,18,,,,,
NY Ounce Club,Dolla Trees,18,,,,,
Twic3 Bak3d,Skyworld,18,,,,,
Skyworld,Skyworld,18,,,,,
Lil Lefty,Left COAST,18,,,,,
167 exotics,Dumbo Electric,18,,,,,
Ape,Ape Future One,18,,,,,
Next,Next,18,,,,,
Villains,Next,18,,,,,
Jeeter,Jeeter,18,,,,,
Jungle Girl,1Off,18,,,,,
,Freshly Baked NYC,18,,,,,
,Freshly Baked NYC,18,,,,,
,Freshly Baked NYC,18,,,,,
\.

insert into vendors (name)
select vendor_name
from (
  select distinct on (lower(btrim(vendor_name))) btrim(vendor_name) as vendor_name,
         source_order
  from vendor_seed_stage
  where nullif(btrim(vendor_name), '') is not null
    and btrim(vendor_name) not in ('??', '???')
  order by lower(btrim(vendor_name)), source_order
) canonical_vendors
order by source_order
on conflict do nothing;

insert into vendor_brand_associations (
  vendor_id, brand_name, is_primary, target_days_on_hand, asset_url,
  cod_required, cod_discount_source, minimum_order_dollars, comments
)
select v.id, seeded.brand_name, true, seeded.target_days_on_hand,
       seeded.asset_url, seeded.cod_required, seeded.cod_discount_source,
       seeded.minimum_order_dollars, seeded.comments
from (
  select distinct on (lower(btrim(brand)), lower(btrim(vendor_name)))
         btrim(brand) as brand_name,
         lower(btrim(vendor_name)) as vendor_key,
         target_days_on_hand,
         nullif(btrim(asset_url), '') as asset_url,
         case nullif(btrim(cod_text), '') when 'No' then false when 'Yes' then true else null end
           as cod_required,
         nullif(btrim(cod_discount_source), '') as cod_discount_source,
         minimum_order_dollars,
         nullif(btrim(comments), '') as comments,
         source_order
  from vendor_seed_stage
  where nullif(btrim(brand), '') is not null
    and nullif(btrim(vendor_name), '') is not null
    and btrim(vendor_name) not in ('??', '???')
  order by lower(btrim(brand)), lower(btrim(vendor_name)), source_order
) seeded
join vendors v on lower(v.name) = seeded.vendor_key
order by seeded.source_order
on conflict do nothing;

commit;

\echo 'Migration 104 complete.'
