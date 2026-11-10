-- AVCI V2 TEST - Tanımlamalar ve ilk bakiyeler
-- SADECE V2 TEST. SQL Editor'da bir kez çalıştırın.
-- Var olan işlevleri değiştirmez; yeni güvenli RPC'ler ekler.
BEGIN;
CREATE OR REPLACE FUNCTION public.v2_app_add_definition(p_kind text,p_name text,p_owner_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_id uuid; v_name text:=btrim(p_name);
BEGIN
 IF auth.uid() IS NULL OR NOT public.v2_is_authorized() THEN RAISE EXCEPTION 'Yetkisiz'; END IF;
 IF v_name IS NULL OR length(v_name)<2 OR length(v_name)>120 THEN RAISE EXCEPTION 'Ad 2-120 karakter olmali'; END IF;
 IF p_kind='product_egg' OR p_kind='product_expense' THEN
  INSERT INTO public.v2_products(name,product_type,active) VALUES(v_name,CASE WHEN p_kind='product_egg' THEN 'egg' ELSE 'expense' END,true) RETURNING id INTO v_id;
 ELSIF p_kind='supplier' THEN
  INSERT INTO public.v2_suppliers(name,active) VALUES(v_name,true) RETURNING id INTO v_id;
 ELSIF p_kind IN ('market','customer') THEN
  IF NOT EXISTS(SELECT 1 FROM public.v2_people WHERE id=p_owner_id AND active) THEN RAISE EXCEPTION 'Gecerli kisi secin'; END IF;
  IF p_kind='market' THEN INSERT INTO public.v2_markets(name,owner_id,active) VALUES(v_name,p_owner_id,true) RETURNING id INTO v_id;
  ELSE INSERT INTO public.v2_customers(name,owner_id,active) VALUES(v_name,p_owner_id,true) RETURNING id INTO v_id; END IF;
 ELSE RAISE EXCEPTION 'Gecersiz tanim turu'; END IF;
 RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.v2_app_opening_stock(p_product_id uuid,p_person_id uuid,p_quantity integer,p_unit_cost numeric,p_transfer_price numeric DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_tx uuid; v_wh_in uuid; v_wh_out uuid; v_person_in uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT public.v2_is_authorized() THEN RAISE EXCEPTION 'Yetkisiz'; END IF;
 IF p_quantity IS NULL OR p_quantity<=0 OR p_quantity>100000000 THEN RAISE EXCEPTION 'Gecersiz adet'; END IF;
 IF p_unit_cost IS NULL OR p_unit_cost<0 OR p_unit_cost>1000000 THEN RAISE EXCEPTION 'Gecersiz depo maliyeti'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.v2_products WHERE id=p_product_id AND active) THEN RAISE EXCEPTION 'Urun bulunamadi'; END IF;
 IF p_person_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.v2_people WHERE id=p_person_id AND active) THEN RAISE EXCEPTION 'Kisi bulunamadi'; END IF;
   IF p_transfer_price IS NULL OR p_transfer_price<0 OR p_transfer_price>1000000 THEN RAISE EXCEPTION 'Kisi alis fiyati gerekli'; END IF;
 END IF;
 PERFORM public.v2_lock_stock_owner(NULL);
 IF p_person_id IS NOT NULL THEN PERFORM public.v2_lock_stock_owner(p_person_id); END IF;
 -- Sifirlamadan sonra, ilk gerçek işlemden önce bir kez başlangıç girilir.
 IF EXISTS(SELECT 1 FROM public.v2_transactions WHERE transaction_type NOT IN ('opening')) THEN RAISE EXCEPTION 'Normal islemler baslamis; baslangic stogu eklenemez'; END IF;
 INSERT INTO public.v2_transactions(transaction_type,transaction_date,person_id,note,created_by)
 VALUES('opening',current_date,p_person_id,'Baslangic stogu (kar/borc yaratmaz)',auth.uid()) RETURNING id INTO v_tx;
 INSERT INTO public.v2_stock_movements(transaction_id,product_id,person_id,quantity,unit_cost,price_status,movement_type)
 VALUES(v_tx,p_product_id,NULL,p_quantity,p_unit_cost,'confirmed','purchase_in') RETURNING id INTO v_wh_in;
 IF p_person_id IS NOT NULL THEN
  INSERT INTO public.v2_stock_movements(transaction_id,product_id,person_id,quantity,unit_price,price_status,movement_type)
  VALUES(v_tx,p_product_id,NULL,-p_quantity,p_transfer_price,'confirmed','shipment_out') RETURNING id INTO v_wh_out;
  INSERT INTO public.v2_fifo_allocations(outgoing_movement_id,incoming_movement_id,quantity,unit_cost)
  VALUES(v_wh_out,v_wh_in,p_quantity,p_unit_cost);
  INSERT INTO public.v2_stock_movements(transaction_id,product_id,person_id,quantity,unit_cost,unit_price,price_status,movement_type)
  VALUES(v_tx,p_product_id,p_person_id,p_quantity,p_transfer_price,p_transfer_price,'confirmed','shipment_in') RETURNING id INTO v_person_in;
 END IF;
 RETURN v_tx;
END $$;

CREATE OR REPLACE FUNCTION public.v2_app_opening_balance(p_account_type text,p_account_id uuid,p_amount numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_tx uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT public.v2_is_authorized() THEN RAISE EXCEPTION 'Yetkisiz'; END IF;
 IF p_amount IS NULL OR p_amount<0 OR p_amount>999999999999.99 THEN RAISE EXCEPTION 'Gecersiz bakiye'; END IF;
 IF p_account_type='person' AND NOT EXISTS(SELECT 1 FROM public.v2_people WHERE id=p_account_id) THEN RAISE EXCEPTION 'Kisi bulunamadi'; END IF;
 IF p_account_type='supplier' AND NOT EXISTS(SELECT 1 FROM public.v2_suppliers WHERE id=p_account_id) THEN RAISE EXCEPTION 'Tedarikci bulunamadi'; END IF;
 IF p_account_type='customer' AND NOT EXISTS(SELECT 1 FROM public.v2_customers WHERE id=p_account_id) THEN RAISE EXCEPTION 'Musteri bulunamadi'; END IF;
 IF p_account_type NOT IN ('person','supplier','customer') THEN RAISE EXCEPTION 'Gecersiz hesap'; END IF;
 IF EXISTS(SELECT 1 FROM public.v2_transactions WHERE transaction_type NOT IN ('opening')) THEN RAISE EXCEPTION 'Normal islemler baslamis; baslangic bakiyesi eklenemez'; END IF;
 IF EXISTS(SELECT 1 FROM public.v2_ledger_movements WHERE account_type=p_account_type AND
   (CASE p_account_type WHEN 'person' THEN person_id WHEN 'supplier' THEN supplier_id ELSE customer_id END)=p_account_id)
 THEN RAISE EXCEPTION 'Bu hesaba baslangic bakiyesi zaten girilmis'; END IF;
 INSERT INTO public.v2_transactions(transaction_type,transaction_date,note,created_by)
 VALUES('opening',current_date,'Baslangic cari bakiyesi',auth.uid()) RETURNING id INTO v_tx;
 INSERT INTO public.v2_ledger_movements(transaction_id,account_type,person_id,supplier_id,customer_id,amount,note)
 VALUES(v_tx,p_account_type,CASE WHEN p_account_type='person' THEN p_account_id END,
 CASE WHEN p_account_type='supplier' THEN p_account_id END,
 CASE WHEN p_account_type='customer' THEN p_account_id END,p_amount,'Baslangic borcu') ;
 RETURN v_tx;
END $$;
REVOKE ALL ON FUNCTION public.v2_app_add_definition(text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.v2_app_opening_stock(uuid,uuid,integer,numeric,numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.v2_app_opening_balance(text,uuid,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.v2_app_add_definition(text,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_app_opening_stock(uuid,uuid,integer,numeric,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.v2_app_opening_balance(text,uuid,numeric) TO authenticated;
COMMIT;
